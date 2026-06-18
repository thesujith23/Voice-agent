const { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackSource, TrackKind } = require('@livekit/rtc-node');
const { WaveFile } = require('wavefile');
const axios = require('axios');
const FormData = require('form-data');
const { generateAIResponse } = require('./aiService');
const AgentStorage = require('./agentStorage');

class LivekitAgent {
    constructor(url, token, agentId, roomName) {
        this.url = url;
        this.token = token;
        this.agentConfig = AgentStorage.getAgent(agentId) || { systemPrompt: "You are a helpful AI.", rules: [] };
        this.roomName = roomName;
        this.room = new Room();
        this.audioSource = new AudioSource(8000, 1);
        this.chatHistory = [];
        
        this.isSpeaking = false;
        this.silenceTimer = null;
        this.audioBuffer = [];
        this.interrupted = false;
        this.isAiSpeaking = false;
        this.abortController = null;
    }

    async start() {
        this.setupRoomEvents();
        await this.room.connect(this.url, this.token);
        
        // Publish our audio source
        const track = LocalAudioTrack.createAudioTrack('ai-voice', this.audioSource);
        await this.room.localParticipant.publishTrack(track, {
            name: 'ai-voice',
            source: TrackSource.SourceMicrophone,
        });
        console.log(`LiveKit Agent connected to room ${this.room.name}`);

        // Initialize Chat History
        this.initChatHistory();
        this.greetingSent = false;
        
        // Greet the user if they are already in the room
        if (this.room.remoteParticipants.size > 0) {
            this.sendGreeting();
        }
    }

    async sendGreeting() {
        if (this.agentConfig.greeting && !this.greetingSent) {
            this.greetingSent = true;
            this.chatHistory.push({ role: 'assistant', content: this.agentConfig.greeting });
            await this.sendRoomData('aiText', this.agentConfig.greeting);
            await this.streamTTS(this.agentConfig.greeting);
        }
    }

    initChatHistory() {
        let fullSystemPrompt = "You are a conversational voice AI. Speak naturally like a human on a phone call.\n";
        fullSystemPrompt += "CRITICAL RULES:\n";
        fullSystemPrompt += "1. NEVER use markdown, asterisks, bullet points, or special formatting.\n";
        fullSystemPrompt += "2. Keep your responses extremely concise (1-2 sentences maximum).\n";
        fullSystemPrompt += "3. Only ask ONE simple question at a time.\n";
        fullSystemPrompt += "4. Be warm and conversational.\n\n";
        
        fullSystemPrompt += "AGENT INSTRUCTIONS:\n" + this.agentConfig.systemPrompt + "\n\n";

        if (this.agentConfig.rules && this.agentConfig.rules.length > 0) fullSystemPrompt += "SPECIFIC RULES:\n- " + this.agentConfig.rules.join("\n- ") + "\n\n";
        if (this.agentConfig.faqs && this.agentConfig.faqs.length > 0) fullSystemPrompt += "FAQs:\n" + this.agentConfig.faqs.map(faq => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n") + "\n\n";
        if (this.agentConfig.closingMessage) fullSystemPrompt += `When finishing the conversation, always say: "${this.agentConfig.closingMessage}"`;

        this.chatHistory = [{ role: 'system', content: fullSystemPrompt }];
    }

    setupRoomEvents() {
        this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === TrackKind.KIND_AUDIO) {
                console.log(`Subscribed to audio track from ${participant.identity}`);
                this.consumeAudioTrack(track);
            }
        });

        this.room.on(RoomEvent.ParticipantConnected, (participant) => {
            console.log(`Participant ${participant.identity} joined the room.`);
            this.sendGreeting();
        });

        this.room.on(RoomEvent.Disconnected, () => {
            console.log(`Agent disconnected from ${this.room.name}`);
            if (this.abortController) this.abortController.abort();
        });
    }

    async consumeAudioTrack(track) {
        // Sarvam STT requires 16000Hz or 8000Hz. Let's read at 16000Hz.
        const audioStream = new AudioStream(track, 16000, 1);
        
        for await (const frame of audioStream) {
            this.processAudioFrame(frame);
        }
    }

    processAudioFrame(frame) {
        const samples = frame.data;
        
        // 1. Remove DC offset (low-frequency hum)
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i];
        const mean = sum / samples.length;

        // 2. Calculate true RMS
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
            const val = samples[i] - mean;
            sumSquares += val * val;
        }
        const rms = Math.sqrt(sumSquares / samples.length);

        // Noise gate: ignore sounds below normal conversation level (~40dB = RMS ~100)
        const NOISE_FLOOR_DB = parseInt(process.env.NOISE_FLOOR_DB) || 40;
        const rmsDb = 20 * Math.log10(Math.max(rms, 1));
        if (rmsDb < NOISE_FLOOR_DB) {
            if (this.isSpeaking) {
                this.audioBuffer.push(new Int16Array(samples));
            }
            return;
        }

        // Dynamic VAD threshold: balanced to reject background noise but allow normal speaking volume
        const VAD_THRESHOLD = this.isAiSpeaking ? 3000 : 1500; 

        if (rms > VAD_THRESHOLD) {
            if (!this.isSpeaking) {
                console.log("User started speaking (RMS: " + rms.toFixed(0) + ", dB: " + rmsDb.toFixed(1) + ")");
                this.isSpeaking = true;
                
                // Interrupt AI if it's currently speaking
                if (this.isAiSpeaking) {
                    console.log("Interrupting AI — draining audio queue");
                    this.interrupted = true;
                    if (this.abortController) this.abortController.abort();
                    this.isAiSpeaking = false;
                    this.audioSource.clearQueue();
                }
            }
            clearTimeout(this.silenceTimer);
            this.audioBuffer.push(new Int16Array(samples));
            
            this.silenceTimer = setTimeout(() => {
                this.handleSpeechEnd();
            }, 1000); // 1000ms silence threshold
        } else if (this.isSpeaking) {
            // Buffer trailing silence normally so we don't clip off the ends of words
            this.audioBuffer.push(new Int16Array(samples));
        }
    }

    async sendRoomData(type, text) {
        try {
            const dataStr = JSON.stringify({ type, text });
            await this.room.localParticipant.publishData(
                new TextEncoder().encode(dataStr), 
                { reliable: true, destinationIdentities: [] }
            );
        } catch (e) {
            console.error("Failed to send room data:", e.message);
        }
    }

    async handleSpeechEnd() {
        this.isSpeaking = false;
        this.interrupted = false;

        let totalLength = 0;
        for (const buf of this.audioBuffer) totalLength += buf.length;
        
        // Less than ~0.5 second of audio at 16kHz
        if (totalLength < 8000) { 
             this.audioBuffer = [];
             return;
        }

        const mergedSamples = new Int16Array(totalLength);
        let offset = 0;
        for (const buf of this.audioBuffer) {
            mergedSamples.set(buf, offset);
            offset += buf.length;
        }
        this.audioBuffer = [];

        await this.sendRoomData('status', 'Transcribing...');

        // 1. Encode to WAV
        const wav = new WaveFile();
        wav.fromScratch(1, 16000, '16', mergedSamples); 
        const wavBuffer = wav.toBuffer();

        // 2. Sarvam STT
        try {
            console.log("Sending to Sarvam STT...");
            const form = new FormData();
            form.append('file', Buffer.from(wavBuffer), { filename: 'audio.wav' });
            form.append('model', 'saaras:v3');

            const sttResponse = await axios.post('https://api.sarvam.ai/speech-to-text-translate', form, {
                headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, ...form.getHeaders() }
            });

            const userText = sttResponse.data.transcript;
            console.log("User:", userText);

            if (!userText || userText.trim() === "[Silence]" || userText.trim() === "") {
                await this.sendRoomData('status', 'Idle');
                return;
            }

            this.chatHistory.push({ role: 'user', content: userText });
            await this.sendRoomData('transcript', userText);

            if (this.interrupted) return;

            await this.sendRoomData('status', 'Thinking...');

            // 3. Groq LLM
            let aiResponse = await generateAIResponse(this.chatHistory, false);
            if (!aiResponse) aiResponse = "I'm sorry, I couldn't understand.";
            
            if (aiResponse.length > 490) aiResponse = aiResponse.substring(0, 490);
            
            this.chatHistory.push({ role: 'assistant', content: aiResponse });
            console.log("AI:", aiResponse);

            await this.sendRoomData('aiText', aiResponse);

            if (this.interrupted) return;

            // 4. Sarvam TTS
            await this.streamTTS(aiResponse);

        } catch (err) {
            console.error("Pipeline error:", err.message);
            await this.sendRoomData('status', 'Idle');
        }
    }

    async streamTTS(text) {
        this.isAiSpeaking = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            await this.sendRoomData('status', 'Speaking...');

            // Split into sentences for pseudo-streaming to reduce TTFB
            const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];

            // Start all TTS requests concurrently so they don't block each other
            const ttsPromises = sentences.filter(s => s.trim().length > 0).map(async sentence => {
                const ttsBody = {
                    inputs: [sentence.trim()],
                    target_language_code: "hi-IN",
                    speaker: "shreya",
                    pace: 1.0,
                    speech_sample_rate: 8000,
                    enable_preprocessing: true,
                    model: "bulbul:v3"
                };
                try {
                    return await axios.post('https://api.sarvam.ai/text-to-speech', ttsBody, {
                        headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
                        signal: signal
                    });
                } catch (e) {
                    return { error: e };
                }
            });

            // Process and play them in order as they resolve
            for (const promise of ttsPromises) {
                if (signal.aborted || this.interrupted) {
                    this.audioSource.clearQueue();
                    break;
                }
                
                const response = await promise;
                if (response.error) throw response.error;
                
                if (signal.aborted || this.interrupted) {
                    this.audioSource.clearQueue();
                    break;
                }

                const base64Audio = response.data.audios[0];
                const audioBuffer = Buffer.from(base64Audio, 'base64');
                
                // Decode WAV from Sarvam
                const wav = new WaveFile(audioBuffer);
                wav.toSampleRate(8000);
                const samples = wav.getSamples(false, Int16Array); 

                if (signal.aborted || this.interrupted) {
                    this.audioSource.clearQueue();
                    break;
                }

                // Send to LiveKit AudioSource
                const frame = new AudioFrame(new Int16Array(samples), 8000, 1, samples.length);
                await this.audioSource.captureFrame(frame);
            }
        } catch (err) {
            if (err.name === 'CanceledError') {
                console.log("TTS Generation Cancelled");
            } else {
                console.error("TTS Error:", err.message);
            }
        } finally {
            this.isAiSpeaking = false;
            if (this.interrupted) this.audioSource.clearQueue();
            if (!this.interrupted) await this.sendRoomData('status', 'Idle');
        }
    }
}

module.exports = LivekitAgent;
