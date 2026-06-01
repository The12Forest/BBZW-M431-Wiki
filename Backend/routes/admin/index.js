import express from "express"
import fs from 'fs';
import path from "path";
import { fileURLToPath } from 'url';
import log from './../../function/log.js';
const console = { log: log('GameRouter') };
const router = express.Router()


router.use("/save", (req, res) => {
    let buffer = JSON.stringify(passwords)
    fs.writeFileSync("./Backend/saves/passwords.json", buffer)
    buffer = JSON.stringify(admin_usernames)
    fs.writeFileSync("./Backend/saves/admin_usernames.json", buffer)
    // console.log(logprefix + "Usernames saved:     " + JSON.stringify(admin_usernames))
    console.log(logprefix + "Username saved:      " + '["Hidden"]')
    //   console.log(logprefix + "Passwords saved:     " + JSON.stringify(passwords))
    console.log(logprefix + "Passwords saved:     " + '["Hidden"]')
    res.send("Passwords Saved")
})

router.use("/load", (req, res) => {
    passwords = JSON.parse(fs.readFileSync("./Backend/saves/passwords.json"))
    admin_usernames = JSON.parse(fs.readFileSync("./Backend/saves/admin_usernames.json"))
    passwordreset = JSON.parse(fs.readFileSync("./Backend/saves/admin_usernames.json"))
    // console.log(logprefix + "Passwordresets loaded:  " + JSON.stringify(admin_usernames))
    console.log(logprefix + "Usernames loaded:     " + '["Hidden"]')
    // console.log(logprefix + "Passwords loaded:  " + JSON.stringify(passwords))
    console.log(logprefix + "Passwords loaded:     " + '["Hidden"]')
    res.send("Passwords loaded")
})

router.get("/create/:adminpw/:gamename/:settings", async (req, res) => {
    let response = await fetch('http://127.0.0.1/api/admin/check/' + req.params.adminpw);
    response = await response.json()

    if (response.Okay) {
        if (codesA.indexOf(req.params.gamename) !== 0 || codesB.indexOf(req.params.gamename) !== 0) {
            games.push(req.params.gamename)
            settings.push(req.params.settings)
            let CodeA = makeid(3)
            let CodeB = makeid(3)
            codesA.push(CodeA)
            codesB.push(CodeB)
            res.status(200).json({ "Okay": true, "reason": "Game created!", "GameName": req.params.gamename, "CodeA": CodeA, "CodeB": CodeB })
        } else {
            res.status(500).json({ "Okay": false, "reason": "Game already exists!" })
        }
    } else {
        res.status(400).json({ "Okay": false, "reason": "Error: Wrong Passwd!" })
    }
})

router.get("/checkid/:code", async (req, res) => {
    if (codesA.indexOf(req.params.code) != null) {
        res.status(200).json({ "Okay": true, "teamA": true, "teamB": false })
    } else if (codesB.indexOf(req.params.code) != null) {
        res.status(200).json({ "Okay": true, "teamA": false, "teamB": true })
    } else {
        res.status(200).json({ "Okay": false, "teamA": false, "teamB": false })
    }
})






router.use("", (req, res) => res.status(404).json({ error: "not found" }))

export { router }