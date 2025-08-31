import anthropic

class MCP:
    def __init__(self, api_key):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.context_cache = {}  # Persistent context per session/agent

    def send_message_with_context(self, session_id, message, model="claude-3-sonnet-20240229", tools=None):
        if session_id not in self.context_cache:
            self.context_cache[session_id] = []

        self.context_cache[session_id].append({"role": "user", "content": message})

        response = self.client.messages.create(
            model=model,
            messages=self.context_cache[session_id],
            tools=tools or [],
            max_tokens=1000
        )

        self.context_cache[session_id].append({"role": "assistant", "content": response.content})
        return response.content

    def clear_context(self, session_id):
        if session_id in self.context_cache:
            del self.context_cache[session_id]