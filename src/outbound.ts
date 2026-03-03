import type { ChannelOutboundAdapter, ChannelOutboundContext } from "openclaw/plugin-sdk";

import { sendText as sendAgentText, sendMedia as sendAgentMedia, uploadMedia } from "./agent/api-client.js";
import { resolveWecomAccounts } from "./config/index.js";
import { getWecomRuntime } from "./runtime.js";

import { resolveWecomTarget } from "./target.js";

// --- 新增：按 UTF-8 字节长度安全切分文本的辅助函数 ---
function splitMessageByByteLength(text: string, maxBytes: number): string[] {
  const chunks: string[] =[];
  let currentChunk = "";
  let currentBytes = 0;

  // 优先按换行符切分，尽量避免把 Markdown 语法或一句话生硬切断
  const lines = text.split(/(\n+)/); 
  
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    
    if (currentBytes + lineBytes > maxBytes) {
      // 当前块已有内容，且加上新行超限，则把当前块推入结果
      if (currentBytes > 0) {
        chunks.push(currentChunk);
        currentChunk = "";
        currentBytes = 0;
      }
      
      // 如果单行本身就超过最大限制，必须按字符进行强制切分
      if (lineBytes > maxBytes) {
        let tempStr = "";
        let tempBytes = 0;
        for (const char of line) {
          const charBytes = Buffer.byteLength(char, 'utf8');
          if (tempBytes + charBytes > maxBytes) {
            chunks.push(tempStr);
            tempStr = char;
            tempBytes = charBytes;
          } else {
            tempStr += char;
            tempBytes += charBytes;
          }
        }
        if (tempStr) {
          currentChunk = tempStr;
          currentBytes = tempBytes;
        }
      } else {
        // 单行没超限，成为新块的首行
        currentChunk = line;
        currentBytes = lineBytes;
      }
    } else {
      currentChunk += line;
      currentBytes += lineBytes;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

function resolveAgentConfigOrThrow(cfg: ChannelOutboundContext["cfg"]) {
  const account = resolveWecomAccounts(cfg).agent;
  if (!account?.configured) {
    throw new Error(
      "WeCom outbound requires Agent mode. Configure channels.wecom.agent (corpId/corpSecret/agentId/token/encodingAESKey).",
    );
  }
  console.log(`[wecom-outbound] Using agent config: corpId=${account.corpId}, agentId=${account.agentId}`);
  return account;
}

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunkerMode: "text",
  textChunkLimit: 20480, // 保持核心层的宽松限制，我们在底层精准按 byte 切分
  chunker: (text, limit) => {
    try {
      return getWecomRuntime().channel.text.chunkText(text, limit);
    } catch {
      return [text];
    }
  },
  sendText: async ({ cfg, to, text }: ChannelOutboundContext) => {
    const agent = resolveAgentConfigOrThrow(cfg);
    const target = resolveWecomTarget(to);
    if (!target) {
      throw new Error("WeCom outbound requires a target (userid, partyid, tagid or chatid).");
    }

    let outgoingText = text;
    const trimmed = String(outgoingText ?? "").trim();
    const rawTo = typeof to === "string" ? to.trim().toLowerCase() : "";
    const isAgentSessionTarget = rawTo.startsWith("wecom-agent:");
    const looksLikeNewSessionAck =
      /new session started/i.test(trimmed) && /model:/i.test(trimmed);

    if (looksLikeNewSessionAck) {
      if (!isAgentSessionTarget) {
        console.log(`[wecom-outbound] Suppressed command ack to avoid Bot/Agent double-reply (len=${trimmed.length})`);
        return { channel: "wecom", messageId: `suppressed-${Date.now()}`, timestamp: Date.now() };
      }

      const modelLabel = (() => {
        const m = trimmed.match(/model:\s*([^\n()]+)\s*/i);
        return m?.[1]?.trim();
      })();
      const rewritten = modelLabel ? `✅ 已开启新会话（模型：${modelLabel}）` : "✅ 已开启新会话。";
      console.log(`[wecom-outbound] Rewrote command ack for agent session (len=${rewritten.length})`);
      outgoingText = rewritten;
    }

    const { touser, toparty, totag, chatid } = target;
    if (chatid) {
      throw new Error(
        `企业微信（WeCom）Agent 主动发送不支持向群 chatId 发送（chatId=${chatid}）。` +
          `该路径在实际环境中经常失败（例如 86008：无权限访问该会话/会话由其他应用创建）。` +
          `请改为发送给用户（userid / user:xxx），或由 Bot 模式在群内交付。`,
      );
    }
    console.log(`[wecom-outbound] Sending text to target=${JSON.stringify(target)} (len=${outgoingText.length})`);

    try {
      // 修复问题1：按企微限制的 2048 字节切块后进行循环发送
      const chunks = splitMessageByByteLength(outgoingText, 2048);
      for (const[index, chunk] of chunks.entries()) {
        if (chunks.length > 1) {
          console.log(`[wecom-outbound] Sending chunk ${index + 1}/${chunks.length} (bytes=${Buffer.byteLength(chunk, 'utf8')})`);
        }
        await sendAgentText({
          agent,
          toUser: touser,
          toParty: toparty,
          toTag: totag,
          chatId: chatid,
          text: chunk,
        });
        
        // 发送多块时添加微小延迟，降低触发限频的风险
        if (index < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      console.log(`[wecom-outbound] Successfully sent all chunks to ${JSON.stringify(target)}`);
    } catch (err) {
      console.error(`[wecom-outbound] Failed to send text to ${JSON.stringify(target)}:`, err);
      throw err;
    }

    return {
      channel: "wecom",
      messageId: `agent-${Date.now()}`,
      timestamp: Date.now(),
    };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }: ChannelOutboundContext) => {
    // 这个部分保持原样，未做修改
    const agent = resolveAgentConfigOrThrow(cfg);
    const target = resolveWecomTarget(to);
    if (!target) {
      throw new Error("WeCom outbound requires a target (userid, partyid, tagid or chatid).");
    }
    if (target.chatid) {
      throw new Error(
        `企业微信（WeCom）Agent 主动发送不支持向群 chatId 发送（chatId=${target.chatid}）。` +
          `该路径在实际环境中经常失败（例如 86008：无权限访问该会话/会话由其他应用创建）。` +
          `请改为发送给用户（userid / user:xxx），或由 Bot 模式在群内交付。`,
      );
    }
    if (!mediaUrl) {
      throw new Error("WeCom outbound requires mediaUrl.");
    }

    let buffer: Buffer;
    let contentType: string;
    let filename: string;

    const isRemoteUrl = /^https?:\/\//i.test(mediaUrl);

    if (isRemoteUrl) {
      const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        throw new Error(`Failed to download media: ${res.status}`);
      }
      buffer = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get("content-type") || "application/octet-stream";
      const urlPath = new URL(mediaUrl).pathname;
      filename = urlPath.split("/").pop() || "media";
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      buffer = await fs.readFile(mediaUrl);
      filename = path.basename(mediaUrl);

      const ext = path.extname(mediaUrl).slice(1).toLowerCase();
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        webp: "image/webp", bmp: "image/bmp", mp3: "audio/mpeg", wav: "audio/wav",
        amr: "audio/amr", mp4: "video/mp4", pdf: "application/pdf", doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
      contentType = mimeTypes[ext] || "application/octet-stream";
      console.log(`[wecom-outbound] Reading local file: ${mediaUrl}, ext=${ext}, contentType=${contentType}`);
    }

    let mediaType: "image" | "voice" | "video" | "file" = "file";
    if (contentType.startsWith("image/")) mediaType = "image";
    else if (contentType.startsWith("audio/")) mediaType = "voice";
    else if (contentType.startsWith("video/")) mediaType = "video";

    const mediaId = await uploadMedia({
      agent,
      type: mediaType,
      buffer,
      filename,
    });

    const { touser, toparty, totag, chatid } = target;
    console.log(`[wecom-outbound] Sending media (${mediaType}) to ${JSON.stringify(target)} (mediaId=${mediaId})`);

    try {
      await sendAgentMedia({
        agent,
        toUser: touser,
        toParty: toparty,
        toTag: totag,
        chatId: chatid,
        mediaId,
        mediaType,
        ...(mediaType === "video" && text?.trim()
          ? {
            title: text.trim().slice(0, 64),
            description: text.trim().slice(0, 512),
          }
          : {}),
      });
      console.log(`[wecom-outbound] Successfully sent media to ${JSON.stringify(target)}`);
    } catch (err) {
      console.error(`[wecom-outbound] Failed to send media to ${JSON.stringify(target)}:`, err);
      throw err;
    }

    return {
      channel: "wecom",
      messageId: `agent-media-${Date.now()}`,
      timestamp: Date.now(),
    };
  },
};