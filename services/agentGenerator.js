const { groq } = require('./aiService');
const AgentStorage = require('./agentStorage');

class AgentGenerator {
    static async generate(prompt) {
        const systemInstruction = `You are an expert AI Voice Agent Creator. 
Your task is to generate a comprehensive JSON configuration for a new voice agent based on the user's prompt.
You must output ONLY valid JSON, with no markdown formatting, no backticks, and no extra text.

Make sure the agent's "rules" and "faqs" cover ALL possibilities, including:
1. The happy path (successful interaction)
2. Error handling (what the agent should do if the user asks something irrelevant, or if a required step fails)
3. Edge cases and strict conversational guardrails.

The JSON schema must strictly follow this structure:
{
    "agentName": "string",
    "description": "string",
    "greeting": "string",
    "systemPrompt": "string (Detailed rules for the agent, speaking style, and exact persona)",
    "rules": [ "string", "string" ],
    "faqs": [ { "question": "string", "answer": "string" } ],
    "closingMessage": "string"
}`;

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: prompt }
                ],
                model: "llama-3.1-8b-instant",
                temperature: 0.5,
                max_tokens: 1500
            });

            let responseText = completion.choices[0].message.content.trim();
            
            // Clean up any potential markdown formatting the LLM might have ignored instructions on
            if (responseText.startsWith('```json')) {
                responseText = responseText.replace(/^```json/, '');
            }
            if (responseText.startsWith('```')) {
                responseText = responseText.replace(/^```/, '');
            }
            if (responseText.endsWith('```')) {
                responseText = responseText.replace(/```$/, '');
            }

            const agentData = JSON.parse(responseText.trim());
            
            // Save the agent to the filesystem
            const savedAgent = AgentStorage.saveAgent(agentData);
            return savedAgent;

        } catch (error) {
            console.error("Error generating agent:", error);
            throw new Error("Failed to generate agent configuration from prompt.");
        }
    }
}

module.exports = AgentGenerator;
