// Local dev: serves /public and the API on http://localhost:3000
// (On Vercel this file is unused — vercel.json wires everything up.)
require('dotenv').config();
const express = require('express');
const path = require('path');
const app = require('./api/index');

const server = express();
server.use(express.static(path.join(__dirname, 'public')));
server.use(app);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`BSC Tickets running at http://localhost:${port}`));
