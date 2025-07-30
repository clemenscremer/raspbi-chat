<script lang="ts">
  import { onMount } from 'svelte';

  // We will load these libraries only in the browser
  let marked: any = null;
  let DOMPurify: any = null;

  // onMount runs only on the client-side (in the browser)
  onMount(async () => {
    // Use dynamic import() to load the modules here
    const markedModule = await import('marked');
    marked = markedModule.marked;
    
    const DOMPurifyModule = await import('dompurify');
    DOMPurify = DOMPurifyModule.default;
  });

  // This holds the conversation history
  let messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'assistant', content: 'Hello! How can I help you?' }
  ];

  let userInput = '';
  let isLoading = false;

  async function handleSubmit() {
    if (!userInput.trim() || isLoading) return;

    isLoading = true;
    const currentUserInput = userInput;
    userInput = '';

    messages = [...messages, { role: 'user', content: currentUserInput }];
    messages = [...messages, { role: 'assistant', content: '' }];

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages.slice(0, -1) })
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to get streaming response.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n\n').filter(line => line.trim());
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6);
            if (jsonStr === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(jsonStr);
              const token = parsed.choices[0]?.delta?.content || '';
              messages[messages.length - 1].content += token;
              messages = messages;
            } catch (e) {
              console.error('Could not parse JSON chunk:', jsonStr);
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      messages[messages.length - 1].content = 'Sorry, I encountered an error.';
    } finally {
      isLoading = false;
    }
  }
</script>

<main>
  <h1>Raspbi Liquid Foundation Model Chat</h1>
  <div class="chat-window">
    {#each messages as message}
      <div class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'}>
        <!-- 
          Now we check if the libraries have been loaded.
          On the server, they will be null, so we show plain text.
          In the browser, after onMount, they will exist, and we render HTML.
        -->
        {#if DOMPurify && marked}
          {@html DOMPurify.sanitize(marked.parse(message.content))}
        {:else}
          <!-- Fallback for Server-Side Rendering -->
          <pre style="font-family: inherit; white-space: pre-wrap;">{message.content}</pre>
        {/if}
      </div>
    {/each}
    {#if isLoading && messages[messages.length - 1]?.content === ''}
        <div class="message assistant"><span class="blinking-cursor"></span></div>
    {/if}
  </div>

  <form on:submit|preventDefault={handleSubmit}>
    <input
      type="text"
      bind:value={userInput}
      placeholder="Type your message..."
      disabled={isLoading}
    />
    <button type="submit" disabled={isLoading}>Send</button>
  </form>
</main>

<style>
  main {
    max-width: 768px;
    margin: 0 auto;
    font-family: sans-serif;
    padding: 1em;
  }
  .chat-window {
    height: 70vh;
    overflow-y: auto;
    border: 1px solid #ccc;
    padding: 1em;
    margin-bottom: 1em;
    display: flex;
    flex-direction: column;
  }
  .message {
    margin-bottom: 0.5em;
    padding: 0.5em 1em;
    border-radius: 10px;
    max-width: 80%;
    word-wrap: break-word;
  }
  .message :global(h1), .message :global(h2) {
    margin-top: 0;
  }
  .message :global(ul), .message :global(ol) {
    padding-left: 1.5em;
  }
  .message :global(p) {
    margin: 0.5em 0;
  }
  .assistant {
    background-color: #f1f1f1;
    align-self: flex-start;
  }
  .user {
    background-color: #007bff;
    color: white;
    align-self: flex-end;
  }
  form {
    display: flex;
  }
  input {
    flex-grow: 1;
    padding: 0.5em;
    border: 1px solid #ccc;
    border-radius: 5px;
  }
  button {
    padding: 0.5em 1em;
    border: none;
    background-color: #007bff;
    color: white;
    border-radius: 5px;
    margin-left: 0.5em;
    cursor: pointer;
  }
  button:disabled {
    background-color: #aaa;
  }
  .blinking-cursor {
    display: inline-block;
    width: 8px;
    height: 1em;
    background-color: #333;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink {
    from, to { background-color: transparent }
    50% { background-color: #333; }
  }
</style>