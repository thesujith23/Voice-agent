require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const plivo = require('plivo');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Important for Plivo webhooks
app.use(express.static('public'));

// Ensure public/audio directory exists for Plivo to access TTS files
const audioDir = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
}

// Configure multer to save uploaded audio to a temp file
const upload = multer({ dest: 'uploads/' });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sarvamApiKey = process.env.SARVAM_API_KEY;

// Supabase initialization
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey && supabaseUrl !== 'your_supabase_url_here') {
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.warn("Supabase credentials missing. Logging will be skipped.");
}

// Read knowledge base
let knowledgeBase = "";
try {
    const filePath = path.join(__dirname, 'knowledge.txt');
    knowledgeBase = fs.readFileSync(filePath, 'utf8');
} catch (error) {
    console.error("Error reading knowledge.txt:", error.message);
}

const systemPrompt = `You are a friendly, conversational voice AI receptionist for Sunrise Medical Center. You are talking over the phone with a patient.

CRITICAL RULES FOR CONVERSATION:
1. Speak naturally, as a human receptionist would. Be warm and polite.
2. Be extremely concise. Never speak more than 1 or 2 short sentences.
3. If you ask a question, ask ONLY ONE simple question at a time.
4. DO NOT use formatting, bullet points, emojis, asterisks, or special characters. Use plain text only.
5. Check doctor availability using your tools if the user asks for appointments.
6. Always check the knowledge base before answering.

--- Knowledge Base ---
${knowledgeBase}
----------------------`;

// Chat history to maintain context
let chatHistory = [
    { role: "system", content: systemPrompt }
];
let sessionId = Date.now().toString(); // Unique ID for this conversation



// Helper to generate TTS and save to public folder
async function generateTTS(text, filename) {
    const ttsBody = {
        inputs: [text],
        target_language_code: "hi-IN",
        speaker: "shreya",
        pace: 1.0,
        speech_sample_rate: 8000,
        enable_preprocessing: true,
        model: "bulbul:v3"
    };

    const ttsResponse = await axios.post('https://api.sarvam.ai/text-to-speech', ttsBody, {
        headers: {
            'api-subscription-key': sarvamApiKey,
            'Content-Type': 'application/json'
        }
    });

    const base64Audio = ttsResponse.data.audios[0];
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    const outputPath = path.join(audioDir, filename);
    fs.writeFileSync(outputPath, audioBuffer);
    return `/audio/${filename}`; // Return public relative path
}

app.post('/api/clear', (req, res) => {
    chatHistory = [{ role: "system", content: systemPrompt }];
    sessionId = Date.now().toString();
    res.json({ message: "Chat history cleared" });
});

app.post('/api/start-call', async (req, res) => {
    chatHistory = [{ role: "system", content: systemPrompt }];
    sessionId = Date.now().toString();

    const greetingText = "Welcome to Sunrise Medical Center! I am your AI receptionist. How can I help you today?";
    chatHistory.push({ role: "assistant", content: greetingText });

    try {
        const filename = `greeting-${sessionId}.wav`;
        await generateTTS(greetingText, filename);
        
        const filePath = path.join(audioDir, filename);
        const audioBuffer = fs.readFileSync(filePath);
        const base64Audio = audioBuffer.toString('base64');
        
        res.json({ aiText: greetingText, audioBase64: base64Audio });
    } catch (error) {
        console.error("Error generating greeting:", error.message);
        res.status(500).json({ error: "Failed to generate greeting" });
    }
});

// ------------- BROWSER FRONTEND ENDPOINT ------------- //
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });

    try {
        const audioPath = req.file.path;

        // 1. Sarvam STT
        console.log("Transcribing audio...");
        const sttForm = new FormData();
        sttForm.append('file', fs.createReadStream(audioPath), { filename: 'audio.webm' });
        sttForm.append('model', 'saaras:v3');

        const sttResponse = await axios.post('https://api.sarvam.ai/speech-to-text-translate', sttForm, {
            headers: { 'api-subscription-key': sarvamApiKey, ...sttForm.getHeaders() }
        });

        const userText = sttResponse.data.transcript;
        console.log("User said:", userText);
        fs.unlinkSync(audioPath);

        if (!userText || userText.trim() === "") throw new Error("Could not understand audio");

        // 2. Groq LLM
        chatHistory.push({ role: "user", content: userText });
        console.log("Generating response...");
        let completion = await groq.chat.completions.create({
            messages: chatHistory,
            model: "llama-3.1-8b-instant", // Using a much faster model to reduce lag
            temperature: 0.2, // Lowered temperature to prevent malformed tool syntax
            max_tokens: 150
        });

        const aiText = completion.choices[0].message.content;
        console.log("AI replied:", aiText);
        chatHistory.push({ role: "assistant", content: aiText });

        // 3. Sarvam TTS
        console.log("Synthesizing voice...");
        const ttsBody = {
            inputs: [aiText],
            target_language_code: "hi-IN",
            speaker: "shreya",
            pace: 1.0,
            speech_sample_rate: 8000,
            enable_preprocessing: true,
            model: "bulbul:v3"
        };

        const ttsResponse = await axios.post('https://api.sarvam.ai/text-to-speech', ttsBody, {
            headers: { 'api-subscription-key': sarvamApiKey, 'Content-Type': 'application/json' }
        });

        const base64Audio = ttsResponse.data.audios[0];

        // 4. Log to Supabase
        if (supabase) {
            console.log("Logging conversation to Supabase...");
            const { error: dbError } = await supabase.from('call_logs').insert([
                { session_id: sessionId, input_type: 'voice', transcript: userText, response: aiText }
            ]);
            if (dbError) console.error("Supabase Error:", dbError.message);
        }

        res.json({ userText: userText, aiText: aiText, audioBase64: base64Audio });
    } catch (error) {
        console.error("Pipeline Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to process voice request" });
    }
});


// ------------- PLIVO TELEPHONY ENDPOINTS ------------- //

app.post('/api/incoming-call', async (req, res) => {
    console.log("Incoming call from Plivo!");
    
    // Reset conversation
    chatHistory = [{ role: "system", content: systemPrompt }];
    sessionId = Date.now().toString();

    const greetingText = "Welcome to Sunrise Medical Center! I am your AI receptionist. How can I help you today?";
    chatHistory.push({ role: "assistant", content: greetingText });

    try {
        const audioUrlPath = await generateTTS(greetingText, `greeting-${sessionId}.wav`);
        const fullAudioUrl = `${req.protocol}://${req.get('host')}${audioUrlPath}`;

        const response = new plivo.Response();
        response.addPlay(fullAudioUrl);
        response.addRecord({
            action: `${req.protocol}://${req.get('host')}/api/process-record`,
            method: 'POST',
            redirect: false,
            maxLength: 15, // max recording time in seconds
            playBeep: true
        });

        res.set({ 'Content-Type': 'text/xml' });
        res.end(response.toXML());
    } catch (error) {
        console.error("Error handling incoming call:", error.message);
        res.status(500).send("Error");
    }
});

app.post('/api/process-record', async (req, res) => {
    const recordUrl = req.body.RecordUrl;
    if (!recordUrl) {
        console.error("No recording URL received from Plivo");
        return res.status(400).send("No recording");
    }

    console.log("Received recording from Plivo:", recordUrl);

    try {
        // Download audio from Plivo
        const audioResponse = await axios({ url: recordUrl, responseType: 'stream' });
        const tempAudioPath = path.join(__dirname, 'uploads', `plivo-${Date.now()}.wav`);
        const writer = fs.createWriteStream(tempAudioPath);
        audioResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 1. STT
        console.log("Transcribing phone audio...");
        const sttForm = new FormData();
        sttForm.append('file', fs.createReadStream(tempAudioPath), { filename: 'plivo-audio.wav' });
        sttForm.append('model', 'saaras:v3');

        const sttResponse = await axios.post('https://api.sarvam.ai/speech-to-text-translate', sttForm, {
            headers: { 'api-subscription-key': sarvamApiKey, ...sttForm.getHeaders() }
        });

        const userText = sttResponse.data.transcript;
        console.log("Caller said:", userText);
        fs.unlinkSync(tempAudioPath);

        let aiText = "I'm sorry, I didn't quite catch that. Could you repeat?";

        if (userText && userText.trim() !== "") {
            // 2. Groq LLM
            chatHistory.push({ role: "user", content: userText });
            const completion = await groq.chat.completions.create({
                messages: chatHistory,
                model: "llama-3.1-8b-instant",
                temperature: 0.7,
                max_tokens: 150,
            });

            aiText = completion.choices[0].message.content;
            chatHistory.push({ role: "assistant", content: aiText });

            // 4. Log to Supabase
            if (supabase) {
                console.log("Logging conversation to Supabase...");
                const { error: dbError } = await supabase.from('call_logs').insert([
                    { session_id: sessionId, input_type: 'phone', transcript: userText, response: aiText }
                ]);
                if (dbError) console.error("Supabase Error:", dbError.message);
            }
        }
        
        console.log("AI replied:", aiText);

        // 3. TTS
        const replyFilename = `reply-${Date.now()}.wav`;
        const audioUrlPath = await generateTTS(aiText, replyFilename);
        const fullAudioUrl = `${req.protocol}://${req.get('host')}${audioUrlPath}`;

        // Return XML to Plivo
        const response = new plivo.Response();
        response.addPlay(fullAudioUrl);
        response.addRecord({
            action: `${req.protocol}://${req.get('host')}/api/process-record`,
            method: 'POST',
            redirect: false,
            maxLength: 15,
            playBeep: true
        });

        res.set({ 'Content-Type': 'text/xml' });
        res.end(response.toXML());

    } catch (error) {
        console.error("Plivo Pipeline Error:", error.message);
        
        // Fallback response
        const fallback = new plivo.Response();
        fallback.addSpeak("I'm sorry, we are experiencing technical difficulties. Please try again later.");
        res.set({ 'Content-Type': 'text/xml' });
        res.end(fallback.toXML());
    }
});


app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
