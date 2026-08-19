/**
 * Seed helper — same as initDb (admin bcrypt, Siemens PLC, products, logical label template)
 */
const { initDb } = require('./initDb');

if (require.main === module) {
  initDb()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

module.exports = { initDb };
