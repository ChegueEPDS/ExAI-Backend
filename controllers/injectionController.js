const InjectionRule = require('../models/injectionRule');
const axios = require('axios');

exports.createInjectionRule = async (req, res) => {
  try {
    const { pattern, injectedKnowledge } = req.body;
    const createdBy = req.userId;
    const newRule = new InjectionRule({ pattern, injectedKnowledge, createdBy });
    await newRule.save();
    res.status(201).json(newRule);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create injection rule' });
  }
};

exports.getAllInjectionRules = async (req, res) => {
  try {
    const rules = await InjectionRule.find().sort({ createdAt: -1 });
    res.status(200).json(rules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch injection rules' });
  }
};

exports.deleteInjectionRule = async (req, res) => {
  try {
    const { id } = req.params;
    await InjectionRule.findByIdAndDelete(id);
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

    const updatedRule = await InjectionRule.findByIdAndUpdate(
      id,
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