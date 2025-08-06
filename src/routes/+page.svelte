<script lang="ts">
  import { onMount } from 'svelte';

  let marked: any = null;
  let DOMPurify: any = null;

  onMount(async () => {
    try {
      const markedModule = await import('marked');
      marked = markedModule.marked;
      
      const DOMPurifyModule = await import('dompurify');
      DOMPurify = DOMPurifyModule.default;
    } catch (e) {
      console.error("Failed to load Markdown libraries", e);
    }
  });

  const initialMessage = { 
    role: 'assistant' as const, 
    content: 'Hello! I am LFM2, running on a Raspberry Pi. How can I help you?' 
  };

  let messages: { role: 'user' | 'assistant'; content: string }[] = [initialMessage];

  let userInput = '';
  let isLoading = false;

  function clearChat() {
    messages = [initialMessage];
  }

  async function handleSubmit() {
    if (!userInput.trim() || isLoading) return;

    const currentUserInput = userInput;
    const apiPayload = [...messages, { role: 'user', content: currentUserInput }];
    messages = [...apiPayload, { role: 'assistant', content: '' }];
    
    userInput = '';
    isLoading = true;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiPayload })
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to get streaming response.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      messages[messages.length - 1].content = '';

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
  <div class="header">
    <h1>Raspbi LFM Chat</h1>
    <!-- THIS IS THE KEY CHANGE: Added type="button" -->
    <button type="button" class="clear-button" on:click={clearChat}>Clear Chat</button>
  </div>

  <div class="chat-window">
    {#each messages as message}
      <div class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'}>
        {#if DOMPurify && marked}
          {@html DOMPurify.sanitize(marked.parse(message.content))}
        {:else}
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
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1em;
  }
  h1 {
    margin: 0;
  }
  .chat-window {
    height: 70vh;
    overflow-y: auto;
    border: 1px solid #ccc;
    padding: 1em;
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
  .clear-button {
    background-color: #6c757d;
  }
  .clear-button:hover {
    background-color: #5a6268;
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