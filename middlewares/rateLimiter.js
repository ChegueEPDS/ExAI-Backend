const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 perc időablak
  max: 100, // Max 100 kérés 15 perc alatt egy IP címről
  handler: function (req, res) {
    res.status(429).json({
      status: 'error',
      message: 'Túl sok kérés érkezett. Kérjük, próbálkozz újra 15 perc múlva.'
    });
  }
});

module.exports = limiter;
