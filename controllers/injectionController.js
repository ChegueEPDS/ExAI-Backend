const InjectionRule = require('../models/injectionRule');
const axios = require('axios');

exports.createInjectionRule = async (req, res) => {
  try {
    const { pattern, injectedKnowledge } = req.body;
    const createdBy = req.userId;
    const tenantId = req.scope?.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Missing tenantId in auth scope' });

    const newRule = new InjectionRule({ pattern, injectedKnowledge, createdBy, tenantId });
    await newRule.save();
    res.status(201).json(newRule);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create injection rule' });
  }
};

exports.getAllInjectionRules = async (req, res) => {
  try {
    const role = req.role;
    const tenantId = req.scope?.tenantId;

    const query = (role === 'SuperAdmin') ? {} : { tenantId };
    if (role !== 'SuperAdmin' && !tenantId) {
      return res.status(403).json({ error: 'Missing tenantId in auth scope' });
    }

    const rules = await InjectionRule.find(query).sort({ createdAt: -1 });
    res.status(200).json(rules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch injection rules' });
  }
};

exports.deleteInjectionRule = async (req, res) => {
  try {
    const { id } = req.params;
    const role = req.role;
    const tenantId = req.scope?.tenantId;

    const filter = (role === 'SuperAdmin') ? { _id: id } : { _id: id, tenantId };
    if (role !== 'SuperAdmin' && !tenantId) {
      return res.status(403).json({ error: 'Missing tenantId in auth scope' });
    }

    const deleted = await InjectionRule.findOneAndDelete(filter);
    if (!deleted) return res.status(404).json({ error: 'Injection rule not found' });

    res.status(200).json({ message: 'Injection rule deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete injection rule' });
  }
};

exports.generateInjectionRule = async (req, res) => {
  try {
    const { question, feedback } = req.body;

    const prompt = `You are a regex and domain-expert assistant. Given a question and user feedback, generate a general regex pattern (matching similar questions) and a clear injected knowledge string.

Question: ${question}
Feedback: ${feedback}

Return JSON:
{
  "pattern": "...",
  "injectedKnowledge": "..."
}`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const raw = response.data.choices[0].message.content;

    // 1. Eltávolítjuk a Markdown blokkot (```json és ```)
    const jsonBlock = raw.replace(/```json|```/g, '').trim();

    // 2. JSON biztonságos parse
    try {
      const parsed = JSON.parse(jsonBlock);
      res.json(parsed);
    } catch (jsonError) {
      console.error('❌ Invalid JSON from OpenAI:\n', jsonBlock);
      res.status(500).json({ error: 'Invalid JSON received from OpenAI', raw: jsonBlock });
    }
  } catch (error) {
    console.error('❌ OpenAI call failed:', error.message || error);
    res.status(500).json({ error: 'Failed to generate injection rule suggestion' });
  }
};

exports.updateInjectionRule = async (req, res) => {
  try {
    const { id } = req.params;
    const { pattern, injectedKnowledge } = req.body;
    const role = req.role;
    const tenantId = req.scope?.tenantId;

    const filter = (role === 'SuperAdmin') ? { _id: id } : { _id: id, tenantId };
    if (role !== 'SuperAdmin' && !tenantId) {
      return res.status(403).json({ error: 'Missing tenantId in auth scope' });
    }

    const updatedRule = await InjectionRule.findOneAndUpdate(
      filter,
      { pattern, injectedKnowledge },
      { new: true }
    );

    if (!updatedRule) {
      return res.status(404).json({ error: 'Injection rule not found' });
    }

    res.json(updatedRule);
  } catch (error) {
    console.error('❌ Failed to update injection rule:', error);
    res.status(500).json({ error: 'Failed to update injection rule' });
  }
};