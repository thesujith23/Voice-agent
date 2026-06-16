const { groq } = require('./aiService');
const AgentStorage = require('./agentStorage');

class AgentGenerator {
    static async generate(prompt, knowledge) {
        const systemInstruction = `You are an expert AI Voice Agent Creator. 
Your task is to generate a comprehensive JSON configuration for a voice agent.

CRITICAL INSTRUCTION:
You must STRICTLY use the user's "ROLE/DESCRIPTION" and "KNOWLEDGE/RULES".
Do NOT hallucinate, guess, or make up ANY random information (no random business hours, no random names, no random services, no random policies). 
If the user does not provide certain details, do not invent them.

However, your job IS to intelligently organize and structure the provided knowledge so that the agent can guide a natural, logical conversation flow.
- Parse the provided knowledge and separate it logically.
- Align the information into a clear conversational flow in the "systemPrompt" (e.g., Step 1: Ask for name, Step 2: Provide available times based on knowledge, etc.).
- Convert the provided knowledge into clear, separated "rules".
- Extract key details into the "faqs" array so the agent can quickly answer specific questions.

The JSON schema must strictly follow this structure:
{
    "agentName": "A suitable name based on the role",
    "description": "A brief description based on the role",
    "greeting": "A welcoming greeting that starts the logical flow",
    "systemPrompt": "A highly readable, clean string detailing the persona and conversational flow. MUST use newline characters (\\n), headings (e.g. PERSONA:, FLOW:), and numbered steps so it is clean and easy for a human to read in a text box.",
    "rules": [ "Array of strict conversational rules organized from the provided knowledge" ],
    "faqs": [ { "question": "string", "answer": "string (strictly based on the knowledge provided)" } ],
    "closingMessage": "A professional sign-off message"
}

You must output ONLY valid JSON, with no markdown formatting, no backticks, and no extra text.`;

        const userContent = `ROLE/DESCRIPTION:\n${prompt}\n\nKNOWLEDGE/RULES:\n${knowledge || "None provided"}`;

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent }
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

    static async edit(currentAgent, editPrompt) {
        const systemInstruction = `You are an expert AI Voice Agent Editor.
Your task is to modify an existing agent configuration based on a user's instruction.
You will be provided with the CURRENT JSON configuration and the USER INSTRUCTION.

CRITICAL INSTRUCTIONS:
1. Apply the user's requested changes intelligently to the relevant fields (e.g., if they ask to change the opening hours, update the rules, faqs, and systemPrompt accordingly).
2. Leave fields untouched if they are completely unrelated to the user's request.
3. Do NOT hallucinate random data. Only change what the user requested.
4. You must output ONLY valid JSON, with no markdown formatting, no backticks, and no extra text.

The JSON schema must strictly follow this structure:
{
    "agentName": "string",
    "description": "string",
    "greeting": "string",
    "systemPrompt": "A highly readable, clean string detailing the persona and conversational flow. MUST use newline characters (\\n) and clear headings so it is easy for a human to read.",
    "rules": [ "string", "string" ],
    "faqs": [ { "question": "string", "answer": "string" } ],
    "closingMessage": "string"
}`;

        const userContent = `CURRENT CONFIGURATION:\n${JSON.stringify(currentAgent, null, 2)}\n\nUSER INSTRUCTION:\n${editPrompt}`;

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent }
                ],
                model: "llama-3.1-8b-instant",
                temperature: 0.3, // Lower temperature for editing to keep it grounded
                max_tokens: 1500
            });

            let responseText = completion.choices[0].message.content.trim();
            
            if (responseText.startsWith('```json')) responseText = responseText.replace(/^```json/, '');
            if (responseText.startsWith('```')) responseText = responseText.replace(/^```/, '');
            if (responseText.endsWith('```')) responseText = responseText.replace(/```$/, '');

            const updatedData = JSON.parse(responseText.trim());
            // Preserve the original ID
            updatedData.id = currentAgent.id;
            
            return AgentStorage.saveAgent(updatedData);

        } catch (error) {
            console.error("Error editing agent:", error);
            throw new Error("Failed to edit agent configuration.");
        }
    }
}

module.exports = AgentGenerator;
