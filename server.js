// Local/self-hosted backend: `npm start`, then open http://localhost:3000.
// Vercel ignores this file — there index.html is static and api/projects.mjs
// runs as a serverless function, same handler either way.
import express from 'express';
import projects from './api/projects.mjs';

const app = express();
app.get('/api/projects', projects);
app.use(express.static(import.meta.dirname));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`portfolio on http://localhost:${port}`));
