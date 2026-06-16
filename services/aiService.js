const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey && supabaseUrl !== 'your_supabase_url_here') {
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.warn("Supabase credentials missing. Logging and tools will be affected.");
}

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

async function generateAIResponse(history, useTools = true) {
    const payload = {
        messages: history,
        model: "llama-3.1-8b-instant",
        temperature: 0.6,
        max_tokens: 500
    };

    if (useTools && tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
    }

    let completion = await groq.chat.completions.create(payload);
    let message = completion.choices[0].message;

    // Handle standard API tool calls
    if (useTools && message.tool_calls) {
        history.push(message);
        
        for (const toolCall of message.tool_calls) {
            console.log("Executing tool:", toolCall.function.name, toolCall.function.arguments);
            const toolResult = await executeTool(toolCall);
            console.log("Tool result:", toolResult);
            history.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: toolResult
            });
        }
        
        completion = await groq.chat.completions.create({
            messages: history,
            model: "llama-3.1-8b-instant",
            temperature: 0.2,
            max_tokens: 500
        });
        
        message = completion.choices[0].message;
    }
    // Handle inline text tool calls (Llama 3 fallback)
    else if (useTools && message.content && message.content.includes('<function=')) {
        const match = message.content.match(/<function=([^>]+)>(.*?)<\/function>/s);
        if (match) {
            const funcName = match[1];
            const funcArgs = match[2];
            console.log("Executing inline tool:", funcName, funcArgs);
            
            history.push({ role: "assistant", content: message.content });
            
            const toolResult = await executeTool({ function: { name: funcName, arguments: funcArgs } });
            console.log("Inline tool result:", toolResult);
            
            history.push({ role: "user", content: `Tool result: ${toolResult}\nPlease respond to the user based on this result. Do not output any more function tags.` });
            
            completion = await groq.chat.completions.create({
                messages: history,
                model: "llama-3.1-8b-instant",
                temperature: 0.2,
                max_tokens: 500
            });
            
            message = completion.choices[0].message;
        }
    }
    
    // Clean any residual tags just in case
    let finalContent = message.content || "";
    finalContent = finalContent.replace(/<function=[^>]+>.*?<\/function>/gs, '').trim();
    // Also remove any unclosed function tags if it still gets cut off
    finalContent = finalContent.replace(/<function=[^>]+>.*$/s, '').trim();
    
    return finalContent;
}

module.exports = {
    generateAIResponse,
    executeTool,
    supabase,
    groq,
    tools
};
