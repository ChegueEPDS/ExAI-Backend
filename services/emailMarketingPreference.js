function isEmailMarketingAllowed(user) {
  return user?.marketingEmailsEnabled !== false;
}

module.exports = { isEmailMarketingAllowed };
