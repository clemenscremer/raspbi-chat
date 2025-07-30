import type { RequestHandler } from './$types';

// IMPORTANT: Replace this with your Raspberry Pi's actual IP address
const PI_LLAMA_SERVER = 'http://192.168.1.98:8080/v1/chat/completions';

export const POST: RequestHandler = async ({ request }) => {
    // Get the messages from the frontend's request
    const { messages } = await request.json();

    // Prepare the data to send to the llama.cpp server
    const llamaPayload = {
        model: 'lfm2-350m',
        messages: messages,
        temperature: 0.3,
        stream: true // Enable streaming
    };

    try {
        // Make the request to the Raspberry Pi
        const piResponse = await fetch(PI_LLAMA_SERVER, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(llamaPayload),
        });

        // Check if the request to the Pi was successful
        if (!piResponse.ok) {
            const errorText = await piResponse.text();
            throw new Error(`Error from Pi server: ${piResponse.status} ${errorText}`);
        }

        // Return the streaming response directly to our frontend
        return new Response(piResponse.body, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            }
        });

    } catch (error) {
        console.error("Error proxying to Pi:", error);
        return new Response(JSON.stringify({ error: 'Failed to connect to the model server.' }), { status: 500 });
    }
};