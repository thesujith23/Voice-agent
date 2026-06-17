const express = require('express');
const AgentGenerator = require('../services/agentGenerator');
const AgentStorage = require('../services/agentStorage');
const { generateAIResponse } = require('../services/aiService');

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const { AccessToken } = require('livekit-server-sdk');
const LivekitAgent = require('../services/livekitService');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: 'uploads/' });

const router = express.Router();

// 1. Generate new agent from prompt
router.post('/generate', async (req, res) => {
    try {
        const { prompt, knowledge } = req.body;
        if (!prompt) return res.status(400).json({ error: "Prompt is required" });

        const agent = await AgentGenerator.generate(prompt, knowledge);
        res.json(agent);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. List all agents
router.get('/', (req, res) => {
    try {
        const agents = AgentStorage.listAgents();
        res.json(agents);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Get specific agent
router.get('/:id', (req, res) => {
    const agent = AgentStorage.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(agent);
});

// 4. Update agent
router.put('/:id', (req, res) => {
    try {
        const data = { id: req.params.id, ...req.body };
        const updatedAgent = AgentStorage.saveAgent(data);
        res.json(updatedAgent);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Delete agent
router.delete('/:id', (req, res) => {
    const success = AgentStorage.deleteAgent(req.params.id);
    if (!success) return res.status(404).json({ error: "Agent not found" });
    res.json({ success: true });
});

// 6. Magic Edit Agent (AI Powered)
router.post('/:id/edit', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: "Edit prompt is required" });

        const agent = AgentStorage.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: "Agent not found" });

        const updatedAgent = await AgentGenerator.edit(agent, prompt);
        res.json(updatedAgent);
    } catch (error) {
        console.error("Magic Edit Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 6. Test Chat with Agent (Text-Based Playground)
router.post('/:id/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });

        const agent = AgentStorage.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: "Agent not found" });

        // Construct the full system prompt
        let fullSystemPrompt = agent.systemPrompt + "\n\n";
        if (agent.rules && agent.rules.length > 0) {
            fullSystemPrompt += "RULES:\n- " + agent.rules.join("\n- ") + "\n\n";
        }
        if (agent.faqs && agent.faqs.length > 0) {
            fullSystemPrompt += "FAQs:\n" + agent.faqs.map(faq => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n") + "\n\n";
        }
        if (agent.closingMessage) {
            fullSystemPrompt += `When finishing the conversation, always say: "${agent.closingMessage}"`;
        }

        // Prepare chat history
        let chatHistory = history || [];
        
        // If it's a new conversation, initialize with system prompt and optionally the greeting
        if (chatHistory.length === 0) {
            chatHistory.push({ role: "system", content: fullSystemPrompt });
            if (agent.greeting) {
                chatHistory.push({ role: "assistant", content: agent.greeting });
            }
        } else {
            // Ensure the first message is the correct system prompt
            if (chatHistory[0].role === 'system') {
                chatHistory[0].content = fullSystemPrompt;
            } else {
                chatHistory.unshift({ role: "system", content: fullSystemPrompt });
            }
        }

        chatHistory.push({ role: "user", content: message });

        // Use the existing Groq generation logic
        const aiResponse = await generateAIResponse(chatHistory);
        
        // Update history manually because generateAIResponse might have added tool calls
        // Actually generateAIResponse mutates the history array passed to it
        res.json({ response: aiResponse, history: chatHistory });
        
    } catch (error) {
        console.error("Playground Chat Error:", error);
        res.status(500).json({ error: "Failed to generate chat response" });
    }
});

// Fetch Initial Greeting
router.get('/:id/greeting', async (req, res) => {
    try {
        const agent = AgentStorage.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: "Agent not found" });

        const greeting = agent.greeting || "Hello! How can I help you today?";
        
        const sarvamApiKey = process.env.SARVAM_API_KEY;
        const ttsBody = {
            inputs: [greeting],
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

        // Initialize history with universal voice rules
        let fullSystemPrompt = "You are a conversational voice AI. Speak naturally like a human on a phone call.\n";
        fullSystemPrompt += "CRITICAL RULES:\n";
        fullSystemPrompt += "1. NEVER use markdown, asterisks, bullet points, or special formatting.\n";
        fullSystemPrompt += "2. Keep your responses extremely concise (1-2 sentences maximum).\n";
        fullSystemPrompt += "3. Only ask ONE simple question at a time.\n";
        fullSystemPrompt += "4. Be warm and conversational.\n\n";
        
        fullSystemPrompt += "AGENT INSTRUCTIONS:\n" + agent.systemPrompt + "\n\n";

        if (agent.rules && agent.rules.length > 0) fullSystemPrompt += "SPECIFIC RULES:\n- " + agent.rules.join("\n- ") + "\n\n";
        if (agent.faqs && agent.faqs.length > 0) fullSystemPrompt += "FAQs:\n" + agent.faqs.map(faq => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n") + "\n\n";
        if (agent.closingMessage) fullSystemPrompt += `When finishing the conversation, always say: "${agent.closingMessage}"`;
        
        const history = [
            { role: "system", content: fullSystemPrompt },
            { role: "assistant", content: greeting }
        ];

        res.json({ greetingText: greeting, audioBase64: ttsResponse.data.audios[0], history: history });
    } catch (error) {
        console.error("Greeting Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to generate greeting" });
    }
});

// 7. Generate LiveKit Token & Start Agent
router.post('/:id/livekit', async (req, res) => {
    try {
        const agentId = req.params.id;
        const agent = AgentStorage.getAgent(agentId);
        if (!agent) return res.status(404).json({ error: "Agent not found" });

        const roomName = `room-${agentId}-${Date.now()}`;
        const participantName = `User-${Math.floor(Math.random() * 1000)}`;

        const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
            identity: participantName,
            name: participantName,
        });

        at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
        const userToken = await at.toJwt();

        const agentTokenGen = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
            identity: 'AI-Agent',
            name: 'AI Agent',
        });
        agentTokenGen.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
        const aiToken = await agentTokenGen.toJwt();

        // Start backend agent worker
        const aiAgent = new LivekitAgent(process.env.LIVEKIT_URL, aiToken, agentId, roomName);
        aiAgent.start().catch(e => console.error("Agent failed to start:", e));

        res.json({ token: userToken, room: roomName, url: process.env.LIVEKIT_URL });
    } catch (error) {
        console.error("LiveKit Token Error:", error);
        res.status(500).json({ error: "Failed to generate LiveKit token" });
    }
});

// 7. Test Voice Chat with Agent
router.post('/:id/voice-chat', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No audio file provided" });
        const agent = AgentStorage.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: "Agent not found" });

        let chatHistory = [];
        if (req.body.history) {
            try { chatHistory = JSON.parse(req.body.history); } catch (e) {}
        }

        const audioPath = req.file.path;
        
        // 1. STT via Sarvam
        const sarvamApiKey = process.env.SARVAM_API_KEY;
        const sttForm = new FormData();
        sttForm.append('file', fs.createReadStream(audioPath), { filename: 'audio.webm' });
        sttForm.append('model', 'saaras:v3');

        const sttResponse = await axios.post('https://api.sarvam.ai/speech-to-text-translate', sttForm, {
            headers: { 'api-subscription-key': sarvamApiKey, ...sttForm.getHeaders() }
        });

        let userText = sttResponse.data.transcript;
        fs.unlinkSync(audioPath);

        if (!userText || userText.trim() === "") userText = "[Silence]";

        if (userText === "[Silence]") {
            // Skip LLM and TTS completely to save API calls and prevent TTS errors on empty responses
            return res.json({ userText, response: "", audioBase64: null, history: chatHistory });
        }

        // Construct full system prompt with universal voice rules
        let fullSystemPrompt = "You are a conversational voice AI. Speak naturally like a human on a phone call.\n";
        fullSystemPrompt += "CRITICAL RULES:\n";
        fullSystemPrompt += "1. NEVER use markdown, asterisks, bullet points, or special formatting.\n";
        fullSystemPrompt += "2. Keep your responses extremely concise (1-2 sentences maximum).\n";
        fullSystemPrompt += "3. Only ask ONE simple question at a time.\n";
        fullSystemPrompt += "4. Be warm and conversational.\n\n";
        
        fullSystemPrompt += "AGENT INSTRUCTIONS:\n" + agent.systemPrompt + "\n\n";

        if (agent.rules && agent.rules.length > 0) fullSystemPrompt += "SPECIFIC RULES:\n- " + agent.rules.join("\n- ") + "\n\n";
        if (agent.faqs && agent.faqs.length > 0) fullSystemPrompt += "FAQs:\n" + agent.faqs.map(faq => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n") + "\n\n";
        if (agent.closingMessage) fullSystemPrompt += `When finishing the conversation, always say: "${agent.closingMessage}"`;

        if (chatHistory.length === 0) {
            chatHistory.push({ role: "system", content: fullSystemPrompt });
            if (agent.greeting) chatHistory.push({ role: "assistant", content: agent.greeting });
        } else {
            if (chatHistory[0].role === 'system') chatHistory[0].content = fullSystemPrompt;
            else chatHistory.unshift({ role: "system", content: fullSystemPrompt });
        }

        chatHistory.push({ role: "user", content: userText });

        // 2. LLM via Groq (Disable doctor tools for custom agents)
        let aiResponse = await generateAIResponse(chatHistory, false);
        if (!aiResponse || aiResponse.trim() === "") {
            aiResponse = "I'm sorry, I couldn't process that.";
        }

        // Sarvam TTS has a strict 500 character limit.
        if (aiResponse.length > 490) {
            aiResponse = aiResponse.substring(0, 490);
        }

        // 3. TTS via Sarvam
        const ttsBody = {
            inputs: [aiResponse],
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

        // Save AI response to history so it remembers the conversation
        chatHistory.push({ role: "assistant", content: aiResponse });

        res.json({ userText, response: aiResponse, audioBase64: base64Audio, history: chatHistory });
        
    } catch (error) {
        console.error("Playground Voice Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to generate voice response" });
    }
});

module.exports = router;
