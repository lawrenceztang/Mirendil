import crypto from 'node:crypto';
import { config } from './config.js';

interface OAuthState { nonce:string; expiresAt:number }
const signingKey=()=>{if(config.masterKey.length<32)throw new Error('MASTER_KEY must contain at least 32 characters');return config.masterKey;};

export function createOAuthState():string{
  const payload=Buffer.from(JSON.stringify({nonce:crypto.randomBytes(16).toString('hex'),expiresAt:Date.now()+10*60_000} satisfies OAuthState)).toString('base64url');
  const signature=crypto.createHmac('sha256',signingKey()).update(payload).digest('base64url');return `${payload}.${signature}`;
}

export function verifyOAuthState(state:string):OAuthState{
  const [payload,signature]=state.split('.');if(!payload||!signature)throw new Error('Invalid OAuth state');
  const expected=crypto.createHmac('sha256',signingKey()).update(payload).digest();const supplied=Buffer.from(signature,'base64url');
  if(expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))throw new Error('Invalid OAuth state signature');
  const parsed=JSON.parse(Buffer.from(payload,'base64url').toString()) as OAuthState;
  if(!parsed.nonce||parsed.expiresAt<Date.now())throw new Error('OAuth state expired');return parsed;
}

export async function exchangeGitHubCode(code:string):Promise<{token:string;id:number;login:string;avatarUrl:string|null}>{
  if(!config.githubClientId||!config.githubClientSecret)throw new Error('GitHub OAuth is not configured');
  const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'relay-cloud-agent'},body:JSON.stringify({client_id:config.githubClientId,client_secret:config.githubClientSecret,code})});
  const tokenBody=await tokenResponse.json() as {access_token?:string;error_description?:string};if(!tokenResponse.ok||!tokenBody.access_token)throw new Error(tokenBody.error_description||'GitHub token exchange failed');
  const userResponse=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${tokenBody.access_token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'relay-cloud-agent'}});
  const user=await userResponse.json() as {id?:number;login?:string;avatar_url?:string};if(!userResponse.ok||!user.id||!user.login)throw new Error('Could not verify GitHub identity');return {token:tokenBody.access_token,id:user.id,login:user.login,avatarUrl:user.avatar_url||null};
}
