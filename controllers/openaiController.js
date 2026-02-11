/**********************************************************************************/
/*** Tenant AI profile + Knowledge Base (Vector Stores) management (NO Assistants API) ***/
/**********************************************************************************/

const axios = require('axios');
const logger = require('../config/logger');
const User = require('../models/user');
const fs = require('fs');
const FormData = require('form-data');
const tenantSettingsStore = require('../services/tenantSettingsStore');

function getAuthHeaders() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  return { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
}

async function getTenantIdFromReq(req) {
  const t = req.scope?.tenantId || req.user?.tenantId || null;
  if (t) return String(t);
  // Backward-compat fallback (should not happen with authMiddleware)
  const user = req.userId ? await User.findById(req.userId).select('tenantId').lean() : null;
  return user?.tenantId ? String(user.tenantId) : null;
}

async function getKbVectorStoreIdOrThrow(req) {
  const tenantId = await getTenantIdFromReq(req);
  if (!tenantId) {
    const err = new Error('Missing tenant');
    err.status = 403;
    throw err;
  }
  const v = await tenantSettingsStore.getEffectiveValue(tenantId, 'KB_VECTOR_STORE_ID');
  const id = typeof v === 'string' ? v.trim() : '';
  if (!id) {
    const err = new Error('No KB vector store configured for this tenant.');
    err.status = 404;
    throw err;
  }
  return id;
}

// --- Vector stores (admin) ---
exports.listVectorStores = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 100));
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const after = req.query.after ? String(req.query.after) : undefined;

    const resp = await axios.get('https://api.openai.com/v1/vector_stores', {
      params: { limit, order, ...(after ? { after } : {}) },
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      timeout: 60_000,
    });

    const { data, has_more, first_id, last_id } = resp.data || {};
    const items = Array.isArray(data)
      ? data.map((vs) => ({
          id: vs.id,
          name: vs.name || '',
          created_at: vs.created_at,
          file_counts: vs.file_counts || null,
        }))
      : [];

    return res.json({
      items,
      paging: {
        limit,
        order,
        has_more: !!has_more,
        first_id: first_id || null,
        last_id: last_id || null,
        next_after: last_id || null,
      },
    });
  } catch (err) {
    logger.error('openai.vector_stores.list failed', {
      message: err?.message || String(err),
      status: err?.response?.status || null,
      data: err?.response?.data || null,
    });
    return res.status(500).json({ ok: false, error: 'Failed to list vector stores' });
  }
};

exports.createVectorStore = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

    const resp = await axios.post(
      'https://api.openai.com/v1/vector_stores',
      { name },
      { headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, timeout: 60_000 }
    );

    return res.status(201).json({ ok: true, vectorStore: resp.data });
  } catch (err) {
    logger.error('openai.vector_stores.create failed', {
      message: err?.message || String(err),
      status: err?.response?.status || null,
      data: err?.response?.data || null,
    });
    return res.status(500).json({ ok: false, error: 'Failed to create vector store' });
  }
};

// --- Knowledge base files (vector store files) ---
exports.listAssistantFiles = async (req, res) => {
  try {
    const vectorStoreId = await getKbVectorStoreIdOrThrow(req);

    const PAGE_SIZE = 20;
    const order = (String(req.query.order || 'desc').toLowerCase() === 'asc') ? 'asc' : 'desc';
    const hasPagingParam = !!(req.query.page || req.query.after || req.query.before || req.query.paged);

    async function fetchOnePage(opts = {}) {
      const params = { limit: PAGE_SIZE, order };
      if (opts.after) params.after = opts.after;
      if (opts.before) params.before = opts.before;

      const resp = await axios.get(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`, {
        params,
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        timeout: 60_000,
      });

      const { data, has_more, first_id, last_id } = resp.data || {};
      return { items: data || [], has_more: !!has_more, first_id: first_id || null, last_id: last_id || null };
    }

    async function enrich(items) {
      return Promise.all(
        (items || []).map(async (file) => {
          try {
            const detailRes = await axios.get(`https://api.openai.com/v1/files/${file.id}`, {
              headers: getAuthHeaders(),
              timeout: 60_000,
            });
            return {
              id: file.id,
              filename: detailRes.data.filename,
              status: detailRes.data.status,
              bytes: detailRes.data.bytes,
              created_at: file.created_at,
            };
          } catch {
            return {
              id: file.id,
              filename: file.filename || '(unknown)',
              status: file.status || 'unknown',
              bytes: file.bytes || 0,
              created_at: file.created_at,
            };
          }
        })
      );
    }

    if (hasPagingParam) {
      const page = Math.max(parseInt(String(req.query.page || '1'), 10), 1);
      const afterQP = req.query.after ? String(req.query.after) : null;
      const beforeQP = req.query.before ? String(req.query.before) : null;

      let cursorAfter = afterQP;
      let cursorBefore = beforeQP;

      if (!cursorAfter && !cursorBefore && page > 1) {
        let tmpAfter = null;
        let hasMore = true;
        for (let p = 1; p < page && hasMore; p++) {
          const pg = await fetchOnePage({ after: tmpAfter });
          hasMore = pg.has_more;
          tmpAfter = pg.last_id || null;
          if (!tmpAfter) break;
        }
        cursorAfter = tmpAfter;
      }

      const { items, has_more, first_id, last_id } = await fetchOnePage({ after: cursorAfter, before: cursorBefore });
      const detailed = await enrich(items);

      return res.status(200).json({
        items: detailed,
        paging: {
          page,
          pageSize: PAGE_SIZE,
          order,
          has_more,
          first_id,
          last_id,
          next_after: last_id || null,
          prev_before: first_id || null,
        },
      });
    }

    // Legacy mode: pull multiple pages (backward compatible)
    const MAX_PAGES = parseInt(process.env.OPENAI_VS_MAX_PAGES || '50', 10);
    let all = [];
    let after = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const { items, has_more, last_id } = await fetchOnePage({ after });
      all = all.concat(items || []);
      if (!has_more || !last_id) break;
      after = last_id;
    }
    const detailedAll = await enrich(all);
    return res.status(200).json(detailedAll);
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    logger.error('openai.vector_store.files.list failed', {
      message: err?.message || String(err),
      status,
      data: err?.response?.data || null,
    });
    return res.status(status).json({ ok: false, error: err?.message || 'Failed to list vector store files' });
  }
};

exports.uploadAssistantFile = async (req, res) => {
  try {
    const vectorStoreId = await getKbVectorStoreIdOrThrow(req);

    const file = req.file;
    if (!file || !file.path) return res.status(400).json({ error: 'Nem érkezett fájl a kérésben vagy hiányzik az útvonal.' });

    const form = new FormData();
    // Note: purpose value still applies to file_search/vector_store ingestion.
    form.append('purpose', 'assistants');
    form.append('file', fs.createReadStream(file.path), file.originalname);

    const uploadRes = await axios.post('https://api.openai.com/v1/files', form, {
      headers: { ...getAuthHeaders(), ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: 120_000,
    });

    const fileId = uploadRes.data.id;

    await axios.post(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { file_id: fileId },
      { headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, timeout: 120_000 }
    );

    try {
      fs.unlinkSync(file.path);
    } catch {}

    return res.status(201).json({ message: 'Fájl sikeresen feltöltve és hozzárendelve.', fileId, vectorStoreId });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    logger.error('openai.vector_store.files.upload failed', {
      message: err?.message || String(err),
      status,
      data: err?.response?.data || null,
    });
    return res.status(status).json({ ok: false, error: err?.message || 'Nem sikerült feltölteni a fájlt.' });
  }
};

exports.deleteAssistantFile = async (req, res) => {
  try {
    const vectorStoreId = await getKbVectorStoreIdOrThrow(req);

    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ error: 'Hiányzó fileId paraméter.' });

    await axios.delete(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${fileId}`, {
      headers: getAuthHeaders(),
      timeout: 60_000,
    });

    // Best-effort: delete the underlying OpenAI file too.
    try {
      await axios.delete(`https://api.openai.com/v1/files/${fileId}`, { headers: getAuthHeaders(), timeout: 60_000 });
    } catch {}

    return res.status(200).json({ message: 'Fájl sikeresen törölve.' });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    logger.error('openai.vector_store.files.delete failed', {
      message: err?.message || String(err),
      status,
      data: err?.response?.data || null,
    });
    return res.status(status).json({ ok: false, error: err?.message || 'Nem sikerült törölni a fájlt.' });
  }
};

// --- Tenant AI profile (compat endpoint for EPDS UI) ---
exports.getAssistantInstructions = async (req, res) => {
  try {
    const tenantId = await getTenantIdFromReq(req);
    if (!tenantId) return res.status(403).json({ error: 'Missing tenant' });
    const profile = await tenantSettingsStore.getTenantAiProfile(tenantId);
    return res.status(200).json({
      model: profile.model || '',
      instructions: profile.instructions || '',
    });
  } catch (err) {
    logger.error('tenant.ai_profile.get failed', { message: err?.message || String(err) });
    return res.status(500).json({ error: 'Belső szerver hiba történt.' });
  }
};

exports.updateAssistantConfig = async (req, res) => {
  try {
    const tenantId = await getTenantIdFromReq(req);
    if (!tenantId) return res.status(403).json({ error: 'Missing tenant' });

    const instructions = req.body?.instructions;
    const model = req.body?.model;

    const modelMap = {
      'GPT 4.1': 'gpt-4.1',
      'GPT 4.1 mini': 'gpt-4.1-mini',
      'GPT 4.1 nano': 'gpt-4.1-nano',
      'GPT 4o': 'gpt-4o',
      'GPT 4o mini': 'gpt-4o-mini',
      'o3 mini': 'o3-mini',
      'o1': 'o1',
      'GPT 4': 'gpt-4',
      'GPT 4 turbo': 'gpt-4-turbo',
    };
    const normalizedModel = (typeof model === 'string' && modelMap[model]) ? modelMap[model] : model;

    const settings = {};
    if (instructions !== undefined) settings.AI_INSTRUCTIONS = String(instructions || '');
    if (normalizedModel !== undefined) settings.AI_MODEL = String(normalizedModel || '');

    await tenantSettingsStore.setMany(tenantId, settings, { updatedBy: req.user?.id || req.userId || null });
    const profile = await tenantSettingsStore.getTenantAiProfile(tenantId);
    return res.status(200).json({ ok: true, profile });
  } catch (err) {
    logger.error('tenant.ai_profile.update failed', { message: err?.message || String(err), data: err?.response?.data || null });
    return res.status(500).json({ error: 'Belső szerver hiba történt.' });
  }
};
