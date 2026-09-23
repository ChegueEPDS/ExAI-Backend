// Contribution discounts were part of the removed Stripe billing flow.
// Keep certificate save hooks API-compatible while callers are migrated away.
async function onCertificatesAdded() {
  return { skipped: true, reason: 'billing_removed' };
}

async function issueManualRewardForUser() {
  return { skipped: true, reason: 'billing_removed' };
}

function buildRedeemLinks() {
  return { redeemUrl: null, copyUrl: null, accountUrl: null };
}

module.exports = {
  onCertificatesAdded,
  issueManualRewardForUser,
  buildRedeemLinks,
};
