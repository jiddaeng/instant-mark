import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const isGitHubPages = mode === "github-pages";

  return {
    base: isGitHubPages ? "/instant-mark/" : "/",
    build: {
      outDir: isGitHubPages ? "dist" : "dist/client",
    },
  };
});
