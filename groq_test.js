require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function testGroq() {
    console.log("Loading knowledge file...");
    let knowledgeBase = "";
    try {
        const filePath = path.join(__dirname, 'knowledge.txt');
        knowledgeBase = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        console.error("Error reading knowledge.txt:", error.message);
        return;
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey || apiKey === 'your_groq_api_key_here') {
        console.error("Please add your GROQ_API_KEY to the .env file.");
        return;
    }

    const systemPrompt = `You are a helpful voice AI assistant for a clinic. 
You are speaking over the phone, so keep your responses conversational, concise, and natural to hear.
Use the following information to answer the user's questions:

--- Knowledge Base ---
${knowledgeBase}
----------------------`;

    // The user's mock prompt for this test
    const userPrompt = "Hi, what time do you open on Saturdays and who is your pediatrician?";

    console.log("User Prompt:", userPrompt);
    console.log("Sending request to Groq API...");

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            model: "llama-3.1-8b-instant", // Groq supports various models
            temperature: 0.7,
            max_tokens: 150, // Keep responses concise for voice
        });

        const reply = completion.choices[0].message.content;
        console.log("\n--- Groq Response ---");
        console.log(reply);
        console.log("---------------------\n");
        console.log("Success! Groq is able to read the knowledge file and generate a response.");

    } catch (error) {
        console.error("Error calling Groq API:", error.message);
    }
}

testGroq();
