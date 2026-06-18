const { WebSocketServer } = require('ws');
const axios = require('axios');
const AgentStorage = require('./agentStorage');
const { generateAIResponse } = require('./aiService');
const FormData = require('form-data');
const sarvamApiKey = process.env.SARVAM_API_KEY;

// --- Providers ---
class SarvamSTTProvider {
    async transcribe(audioBuffer) {
        if (!audioBuffer || audioBuffer.length === 0) return "[Silence]";
        try {
            const form = new FormData();
            form.append('file', audioBuffer, { filename: 'audio.webm' });
            form.append('model', 'saaras:v3');
            const response = await axios.post('https://api.sarvam.ai/speech-to-text-translate', form, {
                headers: { 'api-subscription-key': sarvamApiKey, ...form.getHeaders() }
            });
            return response.data.transcript || "[Silence]";
        } catch (error) {
            console.error("STT Error:", error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

class SarvamTTSProvider {
    async synthesize(text) {
        try {
            const ttsBody = {
                inputs: [text],
                target_language_code: process.env.TTS_LANGUAGE_CODE || "en-IN",
                speaker: "shreya",
                pace: 1.0,
                speech_sample_rate: 8000,
                enable_preprocessing: true,
                model: "bulbul:v3"
            };
            const response = await axios.post('https://api.sarvam.ai/text-to-speech', ttsBody, {
                headers: { 'api-subscription-key': sarvamApiKey, 'Content-Type': 'application/json' }
            });
            return response.data.audios[0];
        } catch (error) {
            console.error("TTS Error:", error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

// --- VAD ---
class VoiceActivityDetector {
    constructor(onSpeechStart, onSpeechEnd) {
        this.onSpeechStart = onSpeechStart;
        this.onSpeechEnd = onSpeechEnd;
        this.silenceThreshold = parseInt(process.env.VAD_SILENCE_THRESHOLD) || 1000;
        this.loudChunkMinBytes = parseInt(process.env.VAD_LOUD_CHUNK_BYTES) || 1500;
        this.silenceTimer = null;
        this.isSpeaking = false;
        this.audioBuffer = [];
        this.webmHeader = null; // Store the initial WebM header to prevent decode errors
        this.loudChunkCount = 0;
    }

    processAudioChunk(chunk) {
        if (!this.webmHeader && chunk.length > 0) {
            this.webmHeader = chunk;
        }

        this.audioBuffer.push(chunk);

        // Consider chunk loud if it's above the byte threshold (filters out WebM silence chunks)
        const isLoud = chunk.length > this.loudChunkMinBytes;

        if (isLoud) {
            if (!this.isSpeaking) {
                const started = this.onSpeechStart(chunk.length);
                if (started) {
                    this.isSpeaking = true;
                    this.loudChunkCount = 0;
                }
            }

            if (this.isSpeaking) {
                this.loudChunkCount++;
                // Only reset the silence timer if we receive a loud chunk while speaking!
                clearTimeout(this.silenceTimer);
                
                let currentThreshold = this.silenceThreshold;
                if (this.loudChunkCount > 6) {
                    currentThreshold = 2500;
                } else {
                    currentThreshold = 1000;
                }
                
                this.silenceTimer = setTimeout(() => {
                    this.endSpeech();
                }, currentThreshold);
            }
        } else {
            // It's a quiet chunk.
            if (!this.isSpeaking) {
                // Keep a rolling buffer of ~1 sec pre-roll to prevent memory leaks
                if (this.audioBuffer.length > 4) {
                    this.audioBuffer.shift(); 
                }
            }
            // If we ARE speaking, we do NOT reset the timer. It will naturally expire 
            // after silenceThreshold milliseconds of continuous quiet chunks!
        }
    }

    endSpeech() {
        if (this.isSpeaking) {
            this.isSpeaking = false;
            
            // Prepend the WebM header to the buffer so STT can decode it
            let bufferToCompile = this.audioBuffer;
            if (this.webmHeader && this.audioBuffer.length > 0 && this.audioBuffer[0] !== this.webmHeader) {
                bufferToCompile = [this.webmHeader, ...this.audioBuffer];
            }
            
            const fullBuffer = Buffer.concat(bufferToCompile);
            this.audioBuffer = [];
            this.loudChunkCount = 0;
            this.onSpeechEnd(fullBuffer);
        }
    }
    
    reset() {
        clearTimeout(this.silenceTimer);
        this.isSpeaking = false;
        this.audioBuffer = [];
        this.loudChunkCount = 0;
    }
}

// --- Dynamic Agent Conversation Manager ---
class DynamicConversationManager {
    constructor(agentId) {
        this.agent = AgentStorage.getAgent(agentId);
        if (!this.agent) throw new Error("Agent not found");
        
        let fullSystemPrompt = this.agent.systemPrompt + "\n\n";
        if (this.agent.rules && this.agent.rules.length > 0) fullSystemPrompt += "RULES:\n- " + this.agent.rules.join("\n- ") + "\n\n";
        if (this.agent.faqs && this.agent.faqs.length > 0) fullSystemPrompt += "FAQs:\n" + this.agent.faqs.map(faq => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n") + "\n\n";
        if (this.agent.closingMessage) fullSystemPrompt += `When finishing the conversation, always say: "${this.agent.closingMessage}"`;
        
        fullSystemPrompt += `\nIMPORTANT: When the conversation is completely finished, output the exact text "[END_CALL]" at the very end of your message so the system knows to hang up properly.`;
        
        this.chatHistory = [{ role: "system", content: fullSystemPrompt }];
    }
    
    async generateResponse(userText) {
        this.chatHistory.push({ role: "user", content: userText });
        const aiResponse = await generateAIResponse(this.chatHistory);
        this.chatHistory.push({ role: "assistant", content: aiResponse });
        return aiResponse;
    }
}

// --- WebSocket Session ---
class VoiceSessionManager {
    constructor(ws, sessionId) {
        this.ws = ws;
        this.sessionId = sessionId;
        this.stt = new SarvamSTTProvider();
        this.tts = new SarvamTTSProvider();
        
        this.conversation = null;
        this.isAISpeaking = false;
        this.abortController = null;
        this.interrupted = false;

        this.vad = new VoiceActivityDetector(
            (chunkLength) => this.handleSpeechStart(chunkLength),
            (buffer) => this.handleSpeechEnd(buffer)
        );

        this.ws.on('message', (msg, isBinary) => this.handleMessage(msg, isBinary));
        this.ws.on('close', () => this.handleClose());
        console.log(`[WS Session ${this.sessionId}] Connected`);
    }

    async handleMessage(message, isBinary) {
        if (isBinary) {
            if (this.conversation) this.vad.processAudioChunk(message);
        } else {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'start') {
                    this.conversation = new DynamicConversationManager(data.agentId);
                    if (this.conversation.agent.greeting) {
                        this.conversation.chatHistory.push({ role: "assistant", content: this.conversation.agent.greeting });
                        await this.streamTTS(this.conversation.agent.greeting);
                    }
                }
            } catch(e) {
                console.error("WS Invalid JSON or Agent missing", e);
            }
        }
    }

    handleSpeechStart(chunkLength) {
        // Speech threshold: ignore chunks below this size (filters noise/ambient)
        const SPEECH_THRESHOLD = parseInt(process.env.WS_SPEECH_THRESHOLD) || 1500;
        if (chunkLength < SPEECH_THRESHOLD) {
            return false;
        }

        // If AI is speaking, interrupt it immediately
        if (this.isAISpeaking) {
            console.log(`[WS Session ${this.sessionId}] User interrupted AI`);
            this.interrupted = true;
            if (this.abortController) this.abortController.abort();
            this.isAISpeaking = false;
        }

        console.log(`[WS Session ${this.sessionId}] User started speaking (chunk: ${chunkLength} bytes)`);
        return true;
    }

    async handleSpeechEnd(audioBuffer) {
        console.log(`[WS Session ${this.sessionId}] User stopped speaking. Processing...`);
        this.interrupted = false;
        
        if (audioBuffer.length < 250) {
            this.ws.send(JSON.stringify({ type: 'status', message: 'Idle' }));
            return;
        }

        try {
            this.ws.send(JSON.stringify({ type: 'status', message: 'Transcribing...' }));
            const userText = await this.stt.transcribe(audioBuffer);

            if (userText.includes("[Silence]") || userText.trim() === "") {
                this.ws.send(JSON.stringify({ type: 'status', message: 'Idle' }));
                return;
            }

            this.ws.send(JSON.stringify({ type: 'transcript', text: userText }));

            if (this.interrupted) return;

            this.ws.send(JSON.stringify({ type: 'status', message: 'Thinking...' }));
            let aiText = await this.conversation.generateResponse(userText);
            
            if (this.interrupted) return;

            let shouldEndCall = false;
            if (aiText.includes('[END_CALL]')) {
                shouldEndCall = true;
                aiText = aiText.replace('[END_CALL]', '').trim();
            }

            if (aiText.length > 0) {
                await this.streamTTS(aiText);
            }

            if (shouldEndCall) {
                this.ws.send(JSON.stringify({ type: 'status', message: 'Call Ended' }));
                this.ws.close();
            }

        } catch (error) {
            console.error(`[WS Session ${this.sessionId}] Error processing turn:`, error);
            this.ws.send(JSON.stringify({ type: 'error', message: 'Failed to process audio' }));
        }
    }

    async streamTTS(aiText) {
        this.isAISpeaking = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        this.ws.send(JSON.stringify({ type: 'status', message: 'Speaking...' }));
        this.ws.send(JSON.stringify({ type: 'aiText', text: aiText }));

        const sentences = aiText.match(/[^.!?]+[.!?]+/g) || [aiText];
        
        for (const sentence of sentences) {
            if (signal.aborted || this.interrupted) break;
            if (sentence.trim().length === 0) continue;

            try {
                const base64Audio = await this.tts.synthesize(sentence.trim());
                if (signal.aborted || this.interrupted) break;
                
                this.ws.send(JSON.stringify({ type: 'audio', audio: base64Audio }));
            } catch (error) {
                console.error("TTS streaming error:", error);
                break;
            }
        }
        
        this.isAISpeaking = false;
        if (!this.interrupted) {
            this.ws.send(JSON.stringify({ type: 'status', message: 'Idle' }));
        }
    }

    handleClose() {
        console.log(`[WS Session ${this.sessionId}] Disconnected.`);
        if (this.abortController) this.abortController.abort();
        this.vad.reset();
    }
}

// --- Server Setup ---
function initVoiceWebSocket(server) {
    const wss = new WebSocketServer({ server, path: '/generator-voice-stream' });
    wss.on('connection', (ws) => {
        new VoiceSessionManager(ws, Date.now().toString());
    });
}

module.exports = { initVoiceWebSocket };
