import type { RequestHandler } from './$types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// IMPORTANT: Replace with your Raspberry Pi's details
const PI_LLAMA_SERVER = 'http://192.168.1.98:8080/completion';
const PI_HOST = '192.168.1.98';
const PI_USER = 'clcr'; // Your Pi username

// --- Function Implementation ---
async function get_raspberry_pi_status() {
    try {
        // Execute commands on the remote Pi via SSH
        const tempCommand = `ssh ${PI_USER}@${PI_HOST} "vcgencmd measure_temp"`;
        const memCommand = `ssh ${PI_USER}@${PI_HOST} "free -m | grep Mem | awk '{print \\$3/\\$2 * 100}'"`;
        
        const tempPromise = execAsync(tempCommand);
        const memPromise = execAsync(memCommand);

        const [tempResult, memResult] = await Promise.all([
            tempPromise.catch(e => {
                console.error("Temp command error:", e);
                return { stdout: "N/A", stderr: e.message };
            }),
            memPromise.catch(e => {
                console.error("Memory command error:", e);
                return { stdout: "0", stderr: e.message };
            })
        ]);

        const tempOutput = tempResult.stdout.trim();
        const cpu_temp = tempOutput.includes('temp=') ? tempOutput.replace('temp=', '') : tempOutput;
        
        const memValue = parseFloat(memResult.stdout.trim());
        const memory_usage = !isNaN(memValue) ? `${memValue.toFixed(2)}%` : "N/A";

        console.log("[Tool] Temperature:", cpu_temp);
        console.log("[Tool] Memory:", memory_usage);

        return JSON.stringify({ 
            cpu_temp: cpu_temp || "N/A",
            memory_usage: memory_usage 
        });
    } catch (error) {
        console.error("Error getting Pi status:", error);
        // Fallback: Try to get status via HTTP from the Pi
        try {
            // You could set up a simple HTTP endpoint on the Pi for this
            return JSON.stringify({ 
                cpu_temp: "Unable to connect via SSH",
                memory_usage: "Unable to connect via SSH",
                note: "Ensure SSH key is set up for passwordless access"
            });
        } catch {
            return JSON.stringify({ error: "Could not retrieve Pi status" });
        }
    }
}

// --- Tool Mapping ---
const available_tools: { [key: string]: () => Promise<string> } = {
    get_raspberry_pi_status: get_raspberry_pi_status,
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
        content: `You are LFM2, a helpful assistant running on a Raspberry Pi. You have access to the following tool:

<|tool_list_start|>
[{"name": "get_raspberry_pi_status", "description": "Gets the current CPU temperature and memory usage of the Raspberry Pi"}]
<|tool_list_end|>

When asked about the status, temperature, memory usage, or system information of the Raspberry Pi, you MUST respond with ONLY:
get_raspberry_pi_status()

After receiving tool results, provide a helpful, natural language response explaining the information.`
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
        
        const toolCallRegex = /^([a-zA-Z0-9_]+)\s*\(\s*\)$/;
        const match = toolCallRegex.exec(modelOutput);

        if (match && available_tools[match[1]]) {
            const toolName = match[1];
            console.log(`[Backend] Tool call detected: ${toolName}`);
            
            // Execute the tool
            const toolResult = await available_tools[toolName]();
            console.log(`[Backend] Tool result:`, toolResult);
            
            // Build the conversation with tool result
            const toolMessages = [
                ...messages,
                { role: 'assistant', content: `<|tool_call_start|>[${modelOutput}]<|tool_call_end|>` },
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