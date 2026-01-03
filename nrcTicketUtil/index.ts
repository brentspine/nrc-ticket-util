/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Brentspine
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore,
    FluxDispatcher as Dispatcher,
    GuildChannelStore,
    SelectedChannelStore,
    UserStore
} from "@webpack/common";

type SoundKind = "none" | "beep" | "chime" | "custom";
type ClaimWhere = "name" | "topic" | "either";

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable the plugin",
        default: true
    },

    categoryId: {
        type: OptionType.STRING,
        description: "Watched category ID",
        default: "1420522897381920778"
    },

    claimEmoji: {
        type: OptionType.STRING,
        description: "Your claim emoji (must match what appears in the channel name/topic). Example: 🧩",
        default: "🧩"
    },

    claimWhere: {
        type: OptionType.SELECT,
        description: "Where to look for the claim emoji",
        options: [
            { label: "Channel name", value: "name" satisfies ClaimWhere },
            { label: "Channel topic", value: "topic" satisfies ClaimWhere },
            { label: "Name OR topic", value: "either" satisfies ClaimWhere, default: true }
        ]
    },

    claimOnlyInWatchedCategory: {
        type: OptionType.BOOLEAN,
        description: "Only treat channels as 'claimed' if they are under the watched category",
        default: true
    },

    playOnNewChannel: {
        type: OptionType.BOOLEAN,
        description: "Play sound when a new channel is created under the watched category",
        default: true
    },

    playOnMovedIntoCategory: {
        type: OptionType.BOOLEAN,
        description: "Play sound if a channel is moved into the watched category",
        default: true
    },

    playOnMessageInClaimed: {
        type: OptionType.BOOLEAN,
        description: "Play sound when a new message appears in a channel claimed by you",
        default: true
    },

    onlyWhenUnfocused: {
        type: OptionType.BOOLEAN,
        description: "Only play message sounds when Discord is not focused",
        default: false
    },

    muteWhenViewingChannel: {
        type: OptionType.BOOLEAN,
        description: "Don’t play the message sound if you’re currently viewing that channel",
        default: true
    },

    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore bot messages",
        default: true
    },

    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Ignore your own messages",
        default: true
    },

    newChannelSound: {
        type: OptionType.SELECT,
        description: "Sound for: new channel (or moved into category)",
        options: [
            { label: "None", value: "none" satisfies SoundKind },
            { label: "Beep", value: "beep" satisfies SoundKind, default: true },
            { label: "Chime", value: "chime" satisfies SoundKind },
            { label: "Custom URL", value: "custom" satisfies SoundKind }
        ]
    },

    newChannelSoundUrl: {
        type: OptionType.STRING,
        description: "Custom URL for new-channel sound (mp3/ogg/wav). Used only if set to Custom URL.",
        default: ""
    },

    newChannelVolume: {
        type: OptionType.SLIDER,
        description: "New-channel volume",
        markers: makeRange(0, 1, 0.05),
        default: 0.6,
        stickToMarkers: false
    },

    newChannelCooldownMs: {
        type: OptionType.SLIDER,
        description: "New-channel sound cooldown (ms)",
        markers: makeRange(0, 5000, 250),
        default: 750,
        stickToMarkers: true
    },

    messageSound: {
        type: OptionType.SELECT,
        description: "Sound for: new message in a claimed channel",
        options: [
            { label: "None", value: "none" satisfies SoundKind },
            { label: "Beep", value: "beep" satisfies SoundKind },
            { label: "Chime", value: "chime" satisfies SoundKind, default: true },
            { label: "Custom URL", value: "custom" satisfies SoundKind }
        ]
    },

    messageSoundUrl: {
        type: OptionType.STRING,
        description: "Custom URL for message sound (mp3/ogg/wav). Used only if set to Custom URL.",
        default: ""
    },

    messageVolume: {
        type: OptionType.SLIDER,
        description: "Message volume",
        markers: makeRange(0, 1, 0.05),
        default: 0.7,
        stickToMarkers: false
    },

    messageCooldownMs: {
        type: OptionType.SLIDER,
        description: "Message sound cooldown (ms)",
        markers: makeRange(0, 5000, 250),
        default: 1000,
        stickToMarkers: true
    }
});

let audioCtx: AudioContext | null = null;
let lastNewChannelSoundAt = 0;
let lastMessageSoundAt = 0;

const parentByChannelId = new Map<string, string | null>();
let snapCategoryId = "";

function makeRange(start: number, end: number, step: number): number[] {
    const out: number[] = [];
    const safeStep = step <= 0 ? 1 : step;

    let v = start;
    while (v <= end + 1e-9) {
        out.push(Number(v.toFixed(10)));
        v += safeStep;
    }

    if (out.length >= 2) return out;
    return [start, end];
}

function extractChannel(action: any): any | null {
    const ch = action?.channel;
    if (ch?.id) return ch;

    const upd = action?.updatedChannel;
    if (upd?.id) return upd;

    return null;
}

function getGuildIdForCategory(categoryId: string): string | null {
    const cat = ChannelStore.getChannel(categoryId) as any;
    const gid = cat?.guild_id as string | undefined;

    if (!gid) return null;
    return gid;
}

function getGuildChannels(guildId: string): any[] {
    const data = GuildChannelStore.getChannels(guildId) as any;
    if (!data) return [];

    const selectable = data.SELECTABLE;
    if (Array.isArray(selectable)) return selectable.map((e: any) => e?.channel ?? e).filter(Boolean);

    const channels = data.channels;
    const selectable2 = channels?.SELECTABLE;
    if (Array.isArray(selectable2)) return selectable2.map((e: any) => e?.channel ?? e).filter(Boolean);

    return [];
}

function refreshSnapshotIfNeeded(): void {
    const categoryId = String(settings.store.categoryId ?? "").trim();
    if (!categoryId) return;
    if (categoryId === snapCategoryId) return;

    snapCategoryId = categoryId;
    parentByChannelId.clear();

    const guildId = getGuildIdForCategory(categoryId);
    if (!guildId) return;

    const chans = getGuildChannels(guildId);
    chans.forEach(ch => {
        if (!ch?.id) return;
        parentByChannelId.set(ch.id, ch.parent_id ?? null);
    });
}

function shouldThrottle(now: number, last: number, cooldownMs: number): boolean {
    const cd = Math.max(0, cooldownMs | 0);
    return now - last < cd;
}

function playCustom(url: string, volume: number): void {
    const u = (url ?? "").trim();
    if (!u) return;

    const a = new Audio(u);
    a.volume = Math.max(0, Math.min(1, volume));
    void a.play().catch(() => void 0);
}

function playBeep(volume: number): void {
    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    audioCtx = audioCtx ?? new AudioCtx();
    const ctx = audioCtx;

    void ctx.resume().catch(() => void 0);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const t0 = ctx.currentTime;
    const v = Math.max(0.0001, Math.min(1, volume));

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t0);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t0);
    osc.stop(t0 + 0.2);
}

function playChime(volume: number): void {
    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    audioCtx = audioCtx ?? new AudioCtx();
    const ctx = audioCtx;

    void ctx.resume().catch(() => void 0);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const t0 = ctx.currentTime;
    const v = Math.max(0.0001, Math.min(1, volume));

    osc.type = "triangle";
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.12);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t0);
    osc.stop(t0 + 0.4);
}

function playSound(kind: SoundKind, customUrl: string, volume: number): void {
    if (kind === "none") return;
    if (kind === "custom") playCustom(customUrl, volume);
    if (kind === "beep") playBeep(volume);
    if (kind === "chime") playChime(volume);
}

function channelTextForClaim(channel: any, where: ClaimWhere): string {
    const name = String(channel?.name ?? "");
    const topic = String(channel?.topic ?? "");

    if (where === "name") return name;
    if (where === "topic") return topic;
    return `${name}\n${topic}`;
}

function isClaimedChannel(channelId: string): boolean {
    const emoji = String(settings.store.claimEmoji ?? "").trim();
    if (!emoji) return false;

    const ch = ChannelStore.getChannel(channelId) as any;
    if (!ch) return false;

    const categoryId = String(settings.store.categoryId ?? "").trim();
    const scoped = Boolean(settings.store.claimOnlyInWatchedCategory);

    if (scoped && categoryId) {
        if (ch.parent_id !== categoryId) return false;
    }

    const where = settings.store.claimWhere as ClaimWhere;
    const hay = channelTextForClaim(ch, where);

    return hay.includes(emoji);
}

function shouldPlayMessageSound(channelId: string): boolean {
    if (!settings.store.playOnMessageInClaimed) return false;
    if (!isClaimedChannel(channelId)) return false;

    const onlyWhenUnfocused = Boolean(settings.store.onlyWhenUnfocused);
    if (onlyWhenUnfocused && document.hasFocus()) return false;

    const muteWhenViewing = Boolean(settings.store.muteWhenViewingChannel);
    if (muteWhenViewing && SelectedChannelStore.getChannelId() === channelId) return false;

    return true;
}

function onChannelCreate(action: any): void {
    if (!settings.store.enabled) return;

    refreshSnapshotIfNeeded();

    const ch = extractChannel(action);
    if (!ch) return;

    const categoryId = String(settings.store.categoryId ?? "").trim();
    if (!categoryId) return;

    if (!settings.store.playOnNewChannel) return;
    if (ch.parent_id !== categoryId) return;
    if (ch.type === 4) return;

    parentByChannelId.set(ch.id, ch.parent_id ?? null);

    const now = Date.now();
    const cd = Number(settings.store.newChannelCooldownMs ?? 0);
    if (shouldThrottle(now, lastNewChannelSoundAt, cd)) return;

    lastNewChannelSoundAt = now;

    const kind = settings.store.newChannelSound as SoundKind;
    const url = String(settings.store.newChannelSoundUrl ?? "");
    const vol = Number(settings.store.newChannelVolume ?? 0.6);

    playSound(kind, url, vol);
}

function onChannelUpdate(action: any): void {
    if (!settings.store.enabled) return;

    refreshSnapshotIfNeeded();

    const ch = extractChannel(action);
    if (!ch) return;

    const categoryId = String(settings.store.categoryId ?? "").trim();
    if (!categoryId) return;

    const prevParent = parentByChannelId.get(ch.id) ?? null;
    const nextParent = (ch.parent_id ?? null) as string | null;

    parentByChannelId.set(ch.id, nextParent);

    if (!settings.store.playOnMovedIntoCategory) return;
    if (!settings.store.playOnNewChannel) return;

    if (prevParent === categoryId) return;
    if (nextParent !== categoryId) return;
    if (ch.type === 4) return;

    const now = Date.now();
    const cd = Number(settings.store.newChannelCooldownMs ?? 0);
    if (shouldThrottle(now, lastNewChannelSoundAt, cd)) return;

    lastNewChannelSoundAt = now;

    const kind = settings.store.newChannelSound as SoundKind;
    const url = String(settings.store.newChannelSoundUrl ?? "");
    const vol = Number(settings.store.newChannelVolume ?? 0.6);

    playSound(kind, url, vol);
}

function onMessageCreate(e: any): void {
    if (!settings.store.enabled) return;
    if (e?.type !== "MESSAGE_CREATE") return;
    if (e.optimistic) return;

    const msg = e.message;
    if (!msg) return;

    if (msg.state === "SENDING") return;

    const ignoreBots = Boolean(settings.store.ignoreBots);
    if (ignoreBots && msg.author?.bot) return;

    const ignoreSelf = Boolean(settings.store.ignoreSelf);
    if (ignoreSelf) {
        const me = UserStore.getCurrentUser?.();
        const myId = me?.id;
        if (myId && msg.author?.id === myId) return;
    }

    const channelId = String(e.channelId ?? "");
    if (!channelId) return;

    if (!shouldPlayMessageSound(channelId)) return;

    const now = Date.now();
    const cd = Number(settings.store.messageCooldownMs ?? 0);
    if (shouldThrottle(now, lastMessageSoundAt, cd)) return;

    lastMessageSoundAt = now;

    const kind = settings.store.messageSound as SoundKind;
    const url = String(settings.store.messageSoundUrl ?? "");
    const vol = Number(settings.store.messageVolume ?? 0.7);

    playSound(kind, url, vol);
}

export default definePlugin({
    name: "NrcTicketUtil",
    description: "Plays configurable sounds for new ticket channels and for new messages in channels claimed by your emoji.",
    authors: [{ name: "Brentspine" }],
    settings,

    start() {
        refreshSnapshotIfNeeded();
        Dispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
        Dispatcher.subscribe("CHANNEL_UPDATE", onChannelUpdate);
        Dispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    stop() {
        Dispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
        Dispatcher.unsubscribe("CHANNEL_UPDATE", onChannelUpdate);
        Dispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    }
});
