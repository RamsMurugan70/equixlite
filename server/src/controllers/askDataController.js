const svc = require('../services/askData/askDataService');

async function ask(req, res, next) {
  try {
    const { question } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'question is required' });
    // Missing config is the deployer's situation, not a server fault — reported as 400 with the
    // actual reason rather than falling through to a generic 500 that hides it.
    if (!svc.isConfigured()) {
      return res.status(400).json({ error: 'Ask the Data is not configured — set GEMINI_API_KEY (or ASK_LLM_PROVIDER=ollama) in .env.' });
    }
    res.json(await svc.ask(req.user.id, question));
  } catch (e) { next(e); }
}

async function status(_req, res) {
  res.json({ configured: svc.isConfigured(), ...svc.providerInfo() });
}

module.exports = { ask, status };
