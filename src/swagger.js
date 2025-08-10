// src/swagger.js
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

function setupSwagger(app) {
  const file = path.join(__dirname, 'openapi.yaml');
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc, {
    explorer: true,
    customSiteTitle: 'Gym Platform API Docs'
  }));
  app.get('/openapi.json', (req, res) => res.json(doc));
}

module.exports = { setupSwagger };
