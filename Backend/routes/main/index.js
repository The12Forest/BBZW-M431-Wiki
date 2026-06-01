import express from "express"
import fs from 'fs';
import path from "path";
import { fileURLToPath } from 'url';
import log from './../../function/log.js';
const console = { log: log('GameRouter') };
const router = express.Router()






router.use("", (req, res) => res.status(404).json({ error: "not found" }))


export { router };