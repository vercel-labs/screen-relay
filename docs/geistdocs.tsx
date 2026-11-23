import type {
  GeistdocsAgentReadinessConfig,
  GeistdocsNavbarBrand,
} from "@vercel/geistdocs/config";

export const navbarBrand: GeistdocsNavbarBrand = "labs";

export const Logo = () => (
  <span className="shrink-0 whitespace-nowrap font-sans font-semibold text-[24.4px] text-black leading-none tracking-[-0.05em] dark:text-white">
    screen-relay
  </span>
);

export const github = {
  branch: "main",
  editPath: "docs/content/docs/{path}",
  owner: "vercel-labs",
  repo: "screen-relay",
};

export const nav = [
  {
    label: "Docs",
    href: "/docs",
  },
  {
    label: "Getting started",
    href: "/docs/getting-started",
  },
  {
    label: "GitHub",
    href: "https://github.com/vercel-labs/screen-relay",
  },
];

export const suggestions = [
  "How do I start a desktop session?",
  "How do I control the desktop from an agent?",
  "How do I expose a session through HTTPS?",
  "What are screen-relay's limits?",
];

export const title = "screen-relay";

export const prompt =
  "You are a helpful assistant that answers questions about screen-relay, a tool that streams a Linux desktop to a browser and exposes control through a CLI and a Node SDK.";

export const agent = {
  product: {
    name: "screen-relay",
    description:
      "screen-relay streams a Linux desktop to a browser and lets humans and AI agents control it from a CLI and a Node SDK.",
    category: "Developer tools",
    audience: ["Developers", "AI agents"],
    useCases: [
      "Stream a Linux desktop to a browser",
      "Control a desktop from an agent",
      "Run a desktop in a sandbox or container",
    ],
  },
  api: {
    siteOpenApiUrl: "/openapi.json",
  },
  links: [
    {
      label: "screen-relay source",
      href: "https://github.com/vercel-labs/screen-relay",
      description: "Source repository for screen-relay",
    },
  ],
} satisfies GeistdocsAgentReadinessConfig;

export const translations = {
  en: {
    displayName: "English",
  },
};

export const basePath: string | undefined = undefined;

export const siteId: string | undefined = undefined;
