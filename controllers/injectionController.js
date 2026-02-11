const InjectionRule = require('../models/injectionRule');
const axios = require('axios');
const { createResponse, extractOutputTextFromResponse } = require('../helpers/openaiResponses');

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

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string' },
        injectedKnowledge: { type: 'string' },
      },
      required: ['pattern', 'injectedKnowledge'],
    };

    const respObj = await createResponse({
      model: 'gpt-4o-mini',
      instructions: 'You generate regex patterns and injected knowledge. Return STRICT JSON only.',
      input: [{ role: 'user', content: prompt }],
      store: false,
      temperature: 0.4,
      maxOutputTokens: 600,
      textFormat: { type: 'json_schema', name: 'injection_rule', strict: true, schema },
      timeoutMs: 60_000,
    });

    const txt = String(extractOutputTextFromResponse(respObj) || '').trim();
    const parsed = JSON.parse(txt);
    res.json(parsed);
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
