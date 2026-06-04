function findPreviousUserCategory(messages, assistantIndex) {
  if (!Array.isArray(messages)) return null;
  for (let i = Number(assistantIndex) - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'user' && msg.category) {
      return String(msg.category);
    }
  }
  return null;
}

function attachAssistantRatingCategory(messages, assistantIndex) {
  if (!Array.isArray(messages)) return null;
  const msg = messages[assistantIndex];
  if (!msg || msg.role !== 'assistant') return null;
  const category = findPreviousUserCategory(messages, assistantIndex);
  if (category) {
    msg.assistantRatingCategory = category;
  } else {
    msg.assistantRatingCategory = undefined;
  }
  return category;
}

module.exports = {
  attachAssistantRatingCategory,
  findPreviousUserCategory
};
