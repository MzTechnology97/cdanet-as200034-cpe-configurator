import 'dotenv/config';
import Database from 'better-sqlite3';
import {randomBytes,scryptSync} from 'node:crypto';
import {readFileSync} from 'node:fs';

const input=readFileSync(0,'utf8').split(/\r?\n/);
const username=(input[0]||'').trim(),password=input[1]||'';
if(!/^[A-Za-z0-9._-]{3,80}$/.test(username))throw new Error('Username admin non valido');
if(password.length<14||password.length>200)throw new Error('Password admin: 14-200 caratteri');
const db=new Database(process.env.DB_PATH||'./data/cdanet.sqlite');
const salt=randomBytes(16).toString('hex'),hash=salt+':'+scryptSync(password,salt,64).toString('hex');
const found=db.prepare("SELECT id FROM users WHERE username=?").get(username);
if(found)db.prepare("UPDATE users SET password_hash=?,role='admin',active=1 WHERE username=?").run(hash,username);
else db.prepare("INSERT INTO users(username,password_hash,role,active,created_at) VALUES(?,?, 'admin',1,?)").run(username,hash,new Date().toISOString());
console.log('Admin aggiornato:',username);
db.close();
