require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { WebSocketServer } = require('ws');

// ==========================================
// 1. ENVIRONMENT & CONFIGURATION
// ==========================================
const port = process.env.PORT || 3001;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sarvamApiKey = process.env.SARVAM_API_KEY;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey && supabaseUrl !== 'your_supabase_url_here') {
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.warn("Supabase credentials missing. Logging will be skipped.");
}

let knowledgeBase = "";
try {
    knowledgeBase = fs.readFileSync(path.join(__dirname, 'knowledge.txt'), 'utf8');
} catch (error) {
    console.error("Error reading knowledge.txt:", error.message);
}

// ==========================================
// 2. EXISTING CHATBOT LOGIC (Copied exactly)
// ==========================================
const systemPrompt = `You are a friendly, conversational voice AI receptionist for Sunrise Medical Center. You are talking over the phone with a patient.

CRITICAL RULES FOR CONVERSATION:
1. Speak naturally, as a human receptionist would. Be warm and polite.
2. Be extremely concise. Never speak more than 1 or 2 short sentences.
3. If you ask a question, ask ONLY ONE simple question at a time.
4. DO NOT use formatting, bullet points, emojis, asterisks, or special characters. Use plain text only.
5. Check doctor availability using your tools if the user asks for appointments.
6. Always check the knowledge base before answering.
7. IMPORTANT: When the conversation is completely finished (e.g., after booking is done or the patient says goodbye), output the exact text "[END_CALL]" at the very end of your message so the system knows to hang up properly.

--- Knowledge Base ---
${knowledgeBase}
----------------------`;

const tools = [
    {
        type: "function",
        function: {
            name: "get_doctors",
            description: "Fetch a list of available doctors from the database.",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "get_dates",
            description: "Fetch available dates and slots for a specific doctor from the database.",
            parameters: {
                type: "object",
                properties: { doctor_name: { type: "string", description: "The exact name of the doctor" } },
                required: ["doctor_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_slots",
            description: "Fetch available time slots for a specific doctor and date from the database.",
            parameters: {
                type: "object",
                properties: { 
                    doctor_name: { type: "string", description: "The exact name of the doctor" },
                    appointment_date: { type: "string", description: "The exact date of the appointment" } 
                },
                required: ["doctor_name", "appointment_date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "book_appointment",
            description: "Book an appointment for a patient in the database.",
            parameters: {
                type: "object",
                properties: {
                    patient_name: { type: "string", description: "The name of the patient" },
                    doctor_name: { type: "string", description: "The name of the doctor" },
                    appointment_date: { type: "string", description: "The date of the appointment" },
                    appointment_time: { type: "string", description: "The time slot of the appointment" }
                },
                required: ["patient_name", "doctor_name", "appointment_date", "appointment_time"]
            }
        }
    }
];

async function executeTool(toolCall) {
    const name = toolCall.function.name;
    let args = {};
    try {
        args = JSON.parse(toolCall.function.arguments || '{}');
    } catch (e) {
        return JSON.stringify({ error: "Invalid arguments" });
    }
    
    if (!supabase) return JSON.stringify({ error: "Supabase not configured" });

    if (name === 'get_doctors') {
        const { data, error } = await supabase.from('doctor_availability').select('doctor_name');
        if (error) return JSON.stringify({ error: error.message });
        const uniqueDoctors = [...new Set(data.map(d => d.doctor_name))];
        return JSON.stringify({ doctors: uniqueDoctors });
    }
    if (name === 'get_dates') {
        const { data, error } = await supabase.from('doctor_availability')
            .select('date, available_slots')
            .eq('doctor_name', args.doctor_name);
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify({ dates: data });
    }
    if (name === 'get_slots') {
        const { data, error } = await supabase.from('doctor_availability')
            .select('available_slots')
            .eq('doctor_name', args.doctor_name)
            .eq('date', args.appointment_date);
        if (error) return JSON.stringify({ error: error.message });
        if (data && data.length > 0) {
            return JSON.stringify({ available_slots: data[0].available_slots });
        }
        return JSON.stringify({ available_slots: [] });
    }
    if (name === 'book_appointment') {
        try {
            const apiUrl = `${process.env.SUPABASE_URL}/rest/v1/appointments`;
            const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
            
            const response = await axios.post(apiUrl, {
                patient_name: args.patient_name,
                doctor_name: args.doctor_name,
                appointment_date: args.appointment_date,
                appointment_time: args.appointment_time,
                status: 'confirmed'
            }, {
                headers: {
                    'apikey': apiKey,
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                }
            });
            return JSON.stringify({ success: true, message: "Appointment booked successfully!", data: response.data });
        } catch (error) {
            const errorMessage = error.response ? error.response.data.message : error.message;
            return JSON.stringify({ error: errorMessage });
        }
    }
    return JSON.stringify({ error: "Unknown tool" });
}

// ==========================================
// 3. ABSTRACTION PROVIDERS
// ==========================================

class STTProvider {
    async transcribe(audioBuffer) { throw new Error("Not implemented"); }
}

class SarvamSTTProvider extends STTProvider {
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

class TTSProvider {
    async synthesize(text) { throw new Error("Not implemented"); }
}

class SarvamTTSProvider extends TTSProvider {
    async synthesize(text) {
        try {
            const ttsBody = {
                inputs: [text],
                target_language_code: "hi-IN",
                speaker: "shreya",
                pace: 1.0,
                speech_sample_rate: 8000,
                enable_preprocessing: true,
                model: "bulbul:v3"
            };

            const response = await axios.post('https://api.sarvam.ai/text-to-speech', ttsBody, {
                headers: { 'api-subscription-key': sarvamApiKey, 'Content-Type': 'application/json' }
            });

            return response.data.audios[0]; // Returns base64
        } catch (error) {
            console.error("TTS Error:", error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

class SupabaseLogger {
    static async log(sessionId, userText, aiText) {
        if (supabase) {
            const { error } = await supabase.from('call_logs').insert([
                { session_id: sessionId, input_type: 'voice_stream', transcript: userText, response: aiText }
            ]);
            if (error) console.error("Supabase Log Error:", error.message);
        }
    }
}

// ==========================================
// 4. MANAGERS
// ==========================================

class ConversationManager {
    constructor() {
        this.chatHistory = [{ role: "system", content: systemPrompt }];
    }

    async generateAIResponse(userText) {
        this.chatHistory.push({ role: "user", content: userText });
        
        let completion = await groq.chat.completions.create({
            messages: this.chatHistory,
            model: "llama-3.1-8b-instant",
            temperature: 0.2,
            max_tokens: 150,
            tools: tools,
            tool_choice: "auto"
        });

        let message = completion.choices[0].message;

        if (message.tool_calls) {
            this.chatHistory.push(message);
            
            for (const toolCall of message.tool_calls) {
                console.log("Executing tool:", toolCall.function.name);
                const toolResult = await executeTool(toolCall);
                this.chatHistory.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: toolResult
                });
            }
            
            completion = await groq.chat.completions.create({
                messages: this.chatHistory,
                model: "llama-3.1-8b-instant",
                temperature: 0.2,
                max_tokens: 150
            });
            message = completion.choices[0].message;
        } else if (message.content && message.content.includes('<function=')) {
            // Llama fallback handling from server.js
            const match = message.content.match(/<function=([^>]+)>(.*?)<\/function>/s);
            if (match) {
                const funcName = match[1];
                const funcArgs = match[2];
                this.chatHistory.push({ role: "assistant", content: message.content });
                
                const toolResult = await executeTool({ function: { name: funcName, arguments: funcArgs } });
                this.chatHistory.push({ role: "user", content: `Tool result: ${toolResult}\nPlease respond to the user based on this result. Do not output any more function tags.` });
                
                completion = await groq.chat.completions.create({
                    messages: this.chatHistory,
                    model: "llama-3.1-8b-instant",
                    temperature: 0.2,
                    max_tokens: 150
                });
                message = completion.choices[0].message;
            }
        }

        let finalContent = (message.content || "").replace(/<function=[^>]+>.*?<\/function>/gs, '').trim();
        this.chatHistory.push({ role: "assistant", content: finalContent });
        return finalContent;
    }
}

class VoiceActivityDetector {
    constructor(onSpeechStart, onSpeechEnd) {
        this.onSpeechStart = onSpeechStart;
        this.onSpeechEnd = onSpeechEnd;
        this.silenceThreshold = parseInt(process.env.VAD_SILENCE_THRESHOLD) || 800;
        this.silenceTimer = null;
        this.isSpeaking = false;
        this.audioBuffer = [];
        this.webmHeader = null;
        this.loudChunkCount = 0;
    }

    processAudioChunk(chunk) {
        if (!this.webmHeader && chunk.length > 0) {
            this.webmHeader = chunk;
        }

        this.audioBuffer.push(chunk);
        const isLoud = chunk.length >= 1500;

        if (isLoud) {
            if (!this.isSpeaking) {
                this.isSpeaking = true;
                this.loudChunkCount = 0;
                this.onSpeechStart();
            }
            
            this.loudChunkCount++;
            clearTimeout(this.silenceTimer);
            
            // Dynamic Silence Detection
            // If they spoke less (e.g. < 4 loud chunks ~ 1 sec), wait shorter (1000ms).
            // If they spoke more, they might be pausing to think, so wait longer (2500ms).
            let currentThreshold = this.silenceThreshold;
            if (this.loudChunkCount > 6) {
                currentThreshold = 2500;
            } else {
                currentThreshold = 1000;
            }

            this.silenceTimer = setTimeout(() => {
                this.isSpeaking = false;
                
                let bufferToCompile = this.audioBuffer;
                if (this.webmHeader && this.audioBuffer.length > 0 && this.audioBuffer[0] !== this.webmHeader) {
                    bufferToCompile = [this.webmHeader, ...this.audioBuffer];
                }
                
                const fullBuffer = Buffer.concat(bufferToCompile);
                this.audioBuffer = []; // Clear for next turn
                this.loudChunkCount = 0;
                this.onSpeechEnd(fullBuffer);
            }, currentThreshold);

        } else {
            // It's a quiet chunk.
            if (!this.isSpeaking) {
                // Keep a rolling buffer of ~4 chunks (1 sec) to prevent memory leaks and keep pre-roll
                if (this.audioBuffer.length > 4) {
                    this.audioBuffer.shift(); 
                }
            }
        }
    }
    
    reset() {
        clearTimeout(this.silenceTimer);
        this.isSpeaking = false;
        this.audioBuffer = [];
        this.loudChunkCount = 0;
    }
}

class VoiceSessionManager {
    constructor(ws, sessionId) {
        this.ws = ws;
        this.sessionId = sessionId;
        this.conversation = new ConversationManager();
        this.stt = new SarvamSTTProvider();
        this.tts = new SarvamTTSProvider();
        
        this.isAISpeaking = false;
        this.abortController = null; // Used to cancel TTS generation if interrupted
        this.interrupted = false;

        this.vad = new VoiceActivityDetector(
            () => this.handleSpeechStart(),
            (buffer) => this.handleSpeechEnd(buffer)
        );

        this.ws.on('message', (msg, isBinary) => this.handleMessage(msg, isBinary));
        this.ws.on('close', () => this.handleClose());
        
        console.log(`[Session ${this.sessionId}] Connected`);
    }

    handleMessage(message, isBinary) {
        if (isBinary) {
            this.vad.processAudioChunk(message);
        } else {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'start') {
                    // Start of call, optionally send a greeting
                    this.sendGreeting();
                }
            } catch(e) {
                console.error("Invalid JSON from client");
            }
        }
    }

    async sendGreeting() {
        const greeting = "Welcome to Sunrise Medical Center! I am your AI receptionist. How can I help you today?";
        this.conversation.chatHistory.push({ role: "assistant", content: greeting });
        await this.streamTTS(greeting);
    }

    handleSpeechStart() {
        console.log(`[Session ${this.sessionId}] User started speaking`);
        if (this.isAISpeaking) {
            console.log(`[Session ${this.sessionId}] Barging in! Interrupted AI.`);
            this.interrupted = true;
            this.isAISpeaking = false;
            if (this.abortController) this.abortController.abort();
            this.ws.send(JSON.stringify({ type: 'interrupt' }));
        }
    }

    async handleSpeechEnd(audioBuffer) {
        console.log(`[Session ${this.sessionId}] User stopped speaking. Processing...`);
        this.interrupted = false;
        
        if (audioBuffer.length < 250) {
            console.log(`[Session ${this.sessionId}] Audio too short (${audioBuffer.length} bytes), ignoring.`);
            this.ws.send(JSON.stringify({ type: 'status', message: 'Idle' }));
            return;
        }

        try {
            this.ws.send(JSON.stringify({ type: 'status', message: 'Transcribing...' }));
            const userText = await this.stt.transcribe(audioBuffer);
            console.log(`[Session ${this.sessionId}] Transcript: ${userText}`);

            if (userText.includes("[Silence]") || userText.trim() === "") {
                this.ws.send(JSON.stringify({ type: 'status', message: 'Idle' }));
                return;
            }

            // Send transcript back to UI
            this.ws.send(JSON.stringify({ type: 'transcript', text: userText }));

            if (this.interrupted) return;

            this.ws.send(JSON.stringify({ type: 'status', message: 'Thinking...' }));
            let aiText = await this.conversation.generateAIResponse(userText);
            
            if (this.interrupted) return;

            SupabaseLogger.log(this.sessionId, userText, aiText);

            let shouldEndCall = false;
            if (aiText.includes('[END_CALL]')) {
                shouldEndCall = true;
                aiText = aiText.replace('[END_CALL]', '').trim();
            }

            // Progressive TTS generation
            if (aiText.length > 0) {
                await this.streamTTS(aiText);
            }

            if (shouldEndCall) {
                this.ws.send(JSON.stringify({ type: 'status', message: 'Call Ended' }));
                this.ws.close();
            }

        } catch (error) {
            console.error(`[Session ${this.sessionId}] Error processing turn:`, error);
            this.ws.send(JSON.stringify({ type: 'error', message: 'Failed to process audio' }));
        }
    }

    async streamTTS(aiText) {
        this.isAISpeaking = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        this.ws.send(JSON.stringify({ type: 'status', message: 'Speaking...' }));
        this.ws.send(JSON.stringify({ type: 'aiText', text: aiText })); // Send text immediately

        // Progressive playback: Split by sentences
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
        console.log(`[Session ${this.sessionId}] Disconnected.`);
        if (this.abortController) this.abortController.abort();
        this.vad.reset();
    }
}

// ==========================================
// 5. SERVER SETUP & ROUTES
// ==========================================

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Status Endpoint
app.get('/voice/status', (req, res) => {
    res.json({ status: "active", message: "Voice AI Backend is running" });
});

// Session Creation Endpoint (For frontend to get token/session info before WS connection)
app.post('/voice/session', (req, res) => {
    const sessionId = Date.now().toString();
    res.json({ sessionId, wsUrl: `ws://localhost:${port}/voice-stream` });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/voice-stream' });

wss.on('connection', (ws, req) => {
    const sessionId = Date.now().toString();
    new VoiceSessionManager(ws, sessionId);
});

server.listen(port, () => {
    console.log(`Real-Time Voice API listening on port ${port} (WebSocket path: /voice-stream)`);
    console.log(`Frontend can connect via: ws://localhost:${port}/voice-stream`);
});
