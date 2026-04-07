import { defineConfig } from "vitepress";

export default defineConfig({
  title: "AI Engineering Fundamentals",
  description: "Course notes for the AI Engineering workshop",
  // Lesson notes legitimately link to localhost:5173 (the dev server URL)
  // and similar local addresses that vitepress can't resolve at build time.
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  themeConfig: {
    sidebar: [
      {
        text: "Lessons",
        items: [
          { text: "01. Intro to AI Engineering", link: "/01-intro-to-ai-engineering/" },
          { text: "02. Your First Cloudflare Agent", link: "/02-your-first-cloudflare-agent/" },
          { text: "03. The Chat Experience", link: "/03-the-chat-experience/" },
          { text: "04. The Eval Discipline", link: "/04-the-eval-discipline/" },
          { text: "05. Automated Scorers", link: "/05-automated-scorers/" },
          { text: "06. Context Engineering", link: "/06-context-engineering/" },
        ],
      },
    ],
  },
});
