require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');

const apiKey = process.env.SARVAM_API_KEY;

if (!apiKey || apiKey === 'your_sarvam_api_key_here') {
    console.error("Please add your SARVAM_API_KEY to the .env file.");
    process.exit(1);
}

// 1. Text-to-Speech (TTS)
async function testTTS(text) {
    console.log("Testing Sarvam Text-to-Speech...");
    const url = 'https://api.sarvam.ai/text-to-speech';
    const headers = {
        'api-subscription-key': apiKey,
        'Content-Type': 'application/json'
    };
    
    // As per Sarvam API docs, using bulbul:v3 and a default speaker
    const body = {
        inputs: [text],
        target_language_code: "hi-IN", // Hindi/English code-mixed
        speaker: "shreya",
        pace: 1.0,
        speech_sample_rate: 8000,
        enable_preprocessing: true,
        model: "bulbul:v3"
    };

    try {
        const response = await axios.post(url, body, { headers });
        // The API returns an array of base64 audio strings in 'audios'
        const base64Audio = response.data.audios[0];
        const audioBuffer = Buffer.from(base64Audio, 'base64');
        
        const outputPath = path.join(__dirname, 'output.wav');
        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`Success! TTS generated and saved to ${outputPath}`);
        return outputPath;
    } catch (error) {
        console.error("TTS Error:", error.response ? error.response.data : error.message);
        throw error;
    }
}

// 2. Speech-to-Text (STT)
async function testSTT(audioFilePath) {
    console.log("\nTesting Sarvam Speech-to-Text...");
    const url = 'https://api.sarvam.ai/speech-to-text-translate';
    
    const form = new FormData();
    form.append('file', fs.createReadStream(audioFilePath));
    form.append('model', 'saaras:v3');

    const headers = {
        'api-subscription-key': apiKey,
        ...form.getHeaders()
    };

    try {
        const response = await axios.post(url, form, { headers });
        console.log("Success! STT Transcript:");
        console.log(`"${response.data.transcript}"`);
    } catch (error) {
        console.error("STT Error:", error.response ? error.response.data : error.message);
    }
}

async function runTests() {
    try {
        const sampleText = "Hello! I am your AI receptionist. How can I help you book an appointment today?";
        const audioFile = await testTTS(sampleText);
        
        // Wait a brief moment to ensure file write is complete
        setTimeout(async () => {
            await testSTT(audioFile);
        }, 1000);
        
    } catch (error) {
        console.log("Test sequence failed.");
    }
}

runTests();
