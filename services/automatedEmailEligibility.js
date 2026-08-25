function selectFreeLifecycleEmail({ ageDays, lastLoginAt, downloads = 0 }) {
  const accountAgeDays = Number(ageDays);
  const downloadCount = Math.max(0, Number(downloads) || 0);

  if (!lastLoginAt) {
    if (accountAgeDays >= 20) return 'onboarding_day_20';
    if (accountAgeDays >= 10) return 'onboarding_day_10';
    if (accountAgeDays >= 3) return 'onboarding_day_3';
    return null;
  }

  if (accountAgeDays >= 20 && downloadCount === 0) return 'onboarding_day_20';
  if (accountAgeDays >= 10 && downloadCount === 0) return 'onboarding_day_10';
  return null;
}

module.exports = { selectFreeLifecycleEmail };
