// src/routes/api/chat/+server.ts

import type { RequestHandler } from './$types';
import { promises as fs } from 'fs';
import path from 'path';

// Configuration
const PI_LLAMA_SERVER = 'http://192.168.1.98:8080/completion';
const PI_MCP_SERVER = 'http://192.168.1.98:8765/tool'; // Your new MCP server!

// --- Function Implementation using MCP ---
async function get_raspberry_pi_status() {
    try {
        const response = await fetch(PI_MCP_SERVER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'get_raspberry_pi_status',
                arguments: {}
            })
        });

        if (!response.ok) {
            throw new Error(`MCP server error: ${response.status}`);
        }

        const data = await response.json();
        
        // Log for debugging
        console.log("[MCP] Response:", data);
        
        return JSON.stringify(data);
    } catch (error) {
        console.error("Error calling MCP tool:", error);
        return JSON.stringify({ 
            error: "Could not retrieve Pi status via MCP",
            details: error.message 
        });
    }
}

// --- Tool Mapping --- (ONLY DECLARE THIS ONCE!)
// --- Tool Mapping ---
const available_tools: { [key: string]: () => Promise<string> } = {
    get_raspberry_pi_status: get_raspberry_pi_status,
    get_system_uptime: async () => {
        try {
            const response = await fetch(PI_MCP_SERVER, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'get_system_uptime',
                    arguments: {}
                })
            });
            const data = await response.json();
            return JSON.stringify(data);
        } catch (error) {
            return JSON.stringify({ error: "Could not retrieve uptime" });
        }
    },
    get_network_info: async () => {
        try {
            const response = await fetch(PI_MCP_SERVER, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'get_network_info',
                    arguments: {}
                })
            });
            const data = await response.json();
            return JSON.stringify(data);
        } catch (error) {
            return JSON.stringify({ error: "Could not retrieve network info" });
        }
    },
    get_top_processes: async () => {
        try {
            const response = await fetch(PI_MCP_SERVER, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'get_top_processes',
                    arguments: {}
                })
            });
            const data = await response.json();
            return JSON.stringify(data);
        } catch (error) {
            return JSON.stringify({ error: "Could not retrieve process list" });
        }
    }
};

// Helper to format the prompt for the /completion endpoint
const formatPrompt = (msgs: any[]) => {
    return msgs.map(m => {
        if (m.role === 'system') return `<|im_start|>system\n${m.content}<|im_end|>`;
        if (m.role === 'user') return `<|im_start|>user\n${m.content}<|im_end|>`;
        if (m.role === 'assistant') return `<|im_start|>assistant\n${m.content}<|im_end|>`;
        if (m.role === 'tool') return `<|im_start|>tool\n<|tool_response_start|>${m.content}<|tool_response_end|><|im_end|>`;
        return '';
    }).join('\n') + '\n<|im_start|>assistant\n';
};

// Helper to convert llama.cpp streaming format to OpenAI format
function convertLlamaCppStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    return new ReadableStream({
        async start(controller) {
            try {
                let buffer = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    
                    // Keep the last incomplete line in the buffer
                    buffer = lines.pop() || '';
                    
                    for (const line of lines) {
                        if (line.trim().startsWith('data: ')) {
                            try {
                                const jsonStr = line.substring(6).trim();
                                const data = JSON.parse(jsonStr);
                                
                                // llama.cpp format has 'content' directly
                                if (data.content !== undefined) {
                                    const openAIFormat = {
                                        choices: [{
                                            delta: { content: data.content }
                                        }]
                                    };
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIFormat)}\n\n`));
                                }
                                
                                // Check if this is the final message
                                if (data.stop === true) {
                                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                                    controller.close();
                                    return;
                                }
                            } catch (e) {
                                console.error('Error parsing streaming data:', e, 'Line:', line);
                            }
                        }
                    }
                }
                
                // Process any remaining buffer
                if (buffer.trim()) {
                    console.log('Remaining buffer:', buffer);
                }
                
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            } catch (error) {
                console.error('Stream processing error:', error);
                controller.error(error);
            }
        }
    });
}

// --- Main Request Handler ---
export const POST: RequestHandler = async ({ request }) => {
    let { messages } = await request.json();
    let streamResponse: Response;

    // Add or update system message with tool information
const systemMessage = {
    role: 'system',
    content: `You are LFM2, a helpful assistant running on a Raspberry Pi. You have access to the following tools:

<|tool_list_start|>
[
  {"name": "get_raspberry_pi_status", "description": "Gets CPU temperature, memory usage, and disk usage"},
  {"name": "get_system_uptime", "description": "Gets system uptime and boot time"},
  {"name": "get_network_info", "description": "Gets network interfaces and traffic statistics"},
  {"name": "get_top_processes", "description": "Gets top 5 processes by CPU and memory usage"}
]
<|tool_list_end|>

When asked about system information, uptime, network, or processes, respond with ONLY the appropriate function call like:
get_system_uptime()

Do not add any other text when calling a tool. After receiving tool results, provide a natural language explanation.`
};
    
    // Ensure system message is first
    if (messages[0]?.role !== 'system') {
        messages = [systemMessage, ...messages];
    } else {
        messages[0] = systemMessage; // Replace to avoid accumulation
    }

    // Check if we should look for a tool call
    const lastUserMessage = messages[messages.length - 1];
    const userQuery = lastUserMessage.content.toLowerCase();
        
    const shouldCheckForTool = lastUserMessage.role === 'user' && 
        (userQuery.includes('status') || 
        userQuery.includes('temperature') ||
        userQuery.includes('temp') ||
        userQuery.includes('memory') ||
        userQuery.includes('cpu') ||
        userQuery.includes('uptime') ||      // ADD THIS
        userQuery.includes('network') ||     // ADD THIS  
        userQuery.includes('processes') ||   // ADD THIS
        userQuery.includes('disk') ||         // ADD THIS
        userQuery.includes('system info')) &&
        !userQuery.includes('weather');

    if (shouldCheckForTool) {
        // First call: Check for tool call with grammar
        const grammarPath = path.resolve('grammars/function.gbnf');
        const grammar = await fs.readFile(grammarPath, 'utf-8');

        console.log("[Backend] Checking for tool call with grammar...");
        
        const piResponse = await fetch(PI_LLAMA_SERVER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: formatPrompt(messages),
                n_predict: 128,
                temperature: 0.1,
                stream: false,
                grammar: grammar
            }),
        });

        if (!piResponse.ok) {
            const errorText = await piResponse.text();
            console.error("Error from Pi Server:", errorText);
            throw new Error(`Initial error from Pi server: ${piResponse.status} ${errorText}`);
        }

        const firstResponseData = await piResponse.json();
        const modelOutput = firstResponseData.content.trim();
        
        console.log("[Backend] Model output:", modelOutput);
        
        const toolCallRegex = /^(get_raspberry_pi_status|get_system_uptime|get_network_info|get_top_processes)\s*\(\s*\)$/;
        const match = toolCallRegex.exec(modelOutput.trim());

        if (match && available_tools[match[1]]) {
            const toolName = match[1];
            console.log(`[Backend] Tool call detected: ${toolName}`);
            
            // Execute the tool via MCP
            const toolResult = await available_tools[toolName]();
            console.log(`[Backend] MCP tool result:`, toolResult);
            
            // Build the conversation with tool result - DON'T include the function call in the visible message
            const toolMessages = [
                ...messages,
                { role: 'assistant', content: `<|tool_call_start|>[${modelOutput}]<|tool_call_end|>Checking system information...` },
                { role: 'tool', content: toolResult }
            ];

            // Second call: Generate final response
            console.log("[Backend] Generating final response with tool result...");
            
            const finalPrompt = formatPrompt(toolMessages);
            
            const finalPiResponse = await fetch(PI_LLAMA_SERVER, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: finalPrompt,
                    n_predict: 256,
                    temperature: 0.7,
                    stream: true,
                    cache_prompt: false,
                    stop: ["<|im_end|>", "<|im_start|>", "\n<|"]
                }),
            });

            if (!finalPiResponse.ok) {
                const errorText = await finalPiResponse.text();
                console.error("Secondary error from Pi server:", errorText);
                
                // Parse the tool result for a better fallback
                let fallbackMsg = "I retrieved the system status but encountered an issue displaying it.";
                try {
                    const result = JSON.parse(toolResult);
                    if (result.cpu_temp && result.memory_usage) {
                        fallbackMsg = `The Raspberry Pi's CPU temperature is ${result.cpu_temp} and memory usage is ${result.memory_usage}.`;
                    }
                } catch {}
                
                // Fallback: Create a manual response
                const encoder = new TextEncoder();
                const fallbackStream = new ReadableStream({
                    start(controller) {
                        const data = { choices: [{ delta: { content: fallbackMsg } }] };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        controller.close();
                    }
                });
                streamResponse = new Response(fallbackStream, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            } else {
                // Convert llama.cpp stream to OpenAI format
                const reader = finalPiResponse.body!.getReader();
                const convertedStream = convertLlamaCppStream(reader);
                
                streamResponse = new Response(convertedStream, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            }

        } else {
            // No valid tool call detected
            console.log("[Backend] No valid tool call detected. Model output:", modelOutput);
            const encoder = new TextEncoder();
            const readableStream = new ReadableStream({
                start(controller) {
                    const data = { choices: [{ delta: { content: modelOutput } }] };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            });
            streamResponse = new Response(readableStream, {
                headers: { 'Content-Type': 'text/event-stream' }
            });
        }
    } else {
        // Normal conversation without tool check
        console.log("[Backend] Normal conversation - no tool check needed");
        
        const piResponse = await fetch(PI_LLAMA_SERVER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: formatPrompt(messages),
                n_predict: 512,
                temperature: 0.7,
                stream: true,
                stop: ["<|im_end|>", "<|im_start|>", "\n<|"]
            }),
        });

        if (!piResponse.ok) {
            const errorText = await piResponse.text();
            throw new Error(`Error from Pi server: ${piResponse.status} ${errorText}`);
        }
        
        // Convert llama.cpp stream to OpenAI format
        const reader = piResponse.body!.getReader();
        const convertedStream = convertLlamaCppStream(reader);
        
        streamResponse = new Response(convertedStream, {
            headers: { 'Content-Type': 'text/event-stream' }
        });
    }

    return streamResponse;
};