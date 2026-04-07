import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { streamAgent } from "./agent-core";

interface Env extends Cloudflare.Env {
  OPENAI_API_KEY: string;
  TAVILY_API_KEY: string;
}

export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai("gpt-5.4-mini");
    const messages = await convertToModelMessages(this.messages);

    const result = streamAgent({
      model,
      messages,
      env: { TAVILY_API_KEY: this.env.TAVILY_API_KEY },
    });

    return result.toUIMessageStreamResponse();
  }
}
