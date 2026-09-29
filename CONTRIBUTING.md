# 🤝 Contributing to ai-helper

Thank you for your interest in improving **`ai-helper`**!

---

## 🛠️ Development Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/yourusername/ai-helper.git
   cd ai-helper
   ```

2. **Run with Node.js or Bun**:
   ```bash
   # Run directly with Node.js
   node bin/cli.js status

   # Or with Bun
   bun dev status
   ```

3. **Run Automated Tests**:
   ```bash
   npm test
   ```

---

## 🧩 Adding a New Managed Service

To add a new AI ecosystem service to `aih`:

1. Open `src/config.js`.
2. Add a new service definition to `SERVICES`:
   ```js
   export const SERVICES = {
     // ...
     myservice: {
       id: "myservice",
       name: "myservice",
       command: "npx myservice start",
       description: "My custom AI assistant daemon",
       defaultPort: 8080,
       defaultUrl: "http://localhost:8080",
     },
   };
   ```
3. Add process matching rules in `src/utils/process.js` inside `discoverRunningProcesses()`.
4. Run `npm test` to ensure all test assertions pass.

---

## 📜 Code Style Guidelines

- **Prefer Built-in Modules**: Use Node.js & Bun built-ins; the proxy uses `ws` for WebSocket protocol handling.
- **ES Modules (ESM)**: Always use `import` / `export` syntax with explicit `.js` file extensions.
- **Cross-Platform Safety**: Always verify path and process management on both Windows and Unix.

---

## 🚀 Submitting a Pull Request

1. Fork the repository and create your branch from `main`.
2. Ensure `bun test` passes.
3. Write a clear, descriptive commit message.
4. Submit a Pull Request!
