/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Brentspine
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import {
    closeModal,
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal
} from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelRouter,
    ChannelStore,
    FluxDispatcher as Dispatcher,
    GuildChannelStore,
    SelectedChannelStore,
    UserStore,
    useState
} from "@webpack/common";

type SoundKind = "none" | "beep" | "chime" | "custom";
type ClaimWhere = "name" | "topic" | "either";

type ClaimedTicketInfo = {
    id: string;
    guildId: string;
    name: string;
    topic: string;
    position: number;
};

const UI = {
    modalBg: "var(--modal-background, var(--background-primary, #1e1f22))",
    panelBg: "var(--background-secondary, #2b2d31)",
    panelBgAlt: "var(--background-secondary-alt, #232428)",
    inputBg: "var(--input-background, #1e1f22)",
    border: "var(--background-modifier-accent, rgba(255, 255, 255, 0.12))",
    text: "var(--text-primary, var(--header-primary, #f2f3f5))",
    muted: "var(--text-muted, #b5bac1)",
    brand: "var(--brand-500, #5865f2)",
    brandHover: "var(--brand-560, #4752c4)",
    danger: "var(--status-danger, #ed4245)"
};

function makeRange(start: number, end: number, step: number): number[] {
    const out: number[] = [];
    const safeStep = step <= 0 ? 1 : step;

    let value = start;

    while (value <= end + 1e-9) {
        out.push(Number(value.toFixed(10)));
        value += safeStep;
    }

    if (out.length >= 2) return out;

    return [start, end];
}

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

function extractChannel(action: any): any | null {
    const channel = action?.channel;

    if (channel?.id) return channel;

    const updatedChannel = action?.updatedChannel;

    if (updatedChannel?.id) return updatedChannel;

    return null;
}

function getGuildIdForCategory(categoryId: string): string | null {
    const category = ChannelStore.getChannel(categoryId) as any;
    const guildId = category?.guild_id as string | undefined;

    if (!guildId) return null;

    return guildId;
}

function getCurrentGuildId(): string | null {
    const selectedChannelId = SelectedChannelStore.getChannelId();
    const selectedChannel = ChannelStore.getChannel(selectedChannelId) as any;
    const guildId = selectedChannel?.guild_id as string | undefined;

    if (!guildId) return null;

    return guildId;
}

function getGuildIdForTicketSearch(): string | null {
    const categoryId = String(settings.store.categoryId ?? "").trim();
    const guildIdFromCategory = categoryId ? getGuildIdForCategory(categoryId) : null;

    if (guildIdFromCategory) return guildIdFromCategory;

    return getCurrentGuildId();
}

function getGuildChannels(guildId: string): any[] {
    const data = GuildChannelStore.getChannels(guildId) as any;

    if (!data) return [];

    const selectable = data.SELECTABLE;

    if (Array.isArray(selectable)) {
        return selectable
            .map((entry: any) => entry?.channel ?? entry)
            .filter(Boolean);
    }

    const selectableFromChannels = data.channels?.SELECTABLE;

    if (Array.isArray(selectableFromChannels)) {
        return selectableFromChannels
            .map((entry: any) => entry?.channel ?? entry)
            .filter(Boolean);
    }

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

    const channels = getGuildChannels(guildId);

    channels.forEach(channel => {
        if (!channel?.id) return;

        parentByChannelId.set(channel.id, channel.parent_id ?? null);
    });
}

function shouldThrottle(now: number, last: number, cooldownMs: number): boolean {
    const cooldown = Math.max(0, cooldownMs | 0);

    return now - last < cooldown;
}

function playCustom(url: string, volume: number): void {
    const source = (url ?? "").trim();

    if (!source) return;

    const audio = new Audio(source);
    audio.volume = Math.max(0, Math.min(1, volume));

    void audio.play().catch(() => void 0);
}

function getAudioContext(): AudioContext | null {
    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;

    if (!AudioCtx) return null;

    audioCtx = audioCtx ?? new AudioCtx();

    return audioCtx;
}

function playBeep(volume: number): void {
    const ctx = getAudioContext();

    if (!ctx) return;

    void ctx.resume().catch(() => void 0);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const t0 = ctx.currentTime;
    const safeVolume = Math.max(0.0001, Math.min(1, volume));

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t0);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(safeVolume, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t0);
    osc.stop(t0 + 0.2);
}

function playChime(volume: number): void {
    const ctx = getAudioContext();

    if (!ctx) return;

    void ctx.resume().catch(() => void 0);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const t0 = ctx.currentTime;
    const safeVolume = Math.max(0.0001, Math.min(1, volume));

    osc.type = "triangle";
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.12);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(safeVolume, t0 + 0.01);
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

function getChannelTopic(channel: any): string {
    return String(channel?.topic ?? channel?.rawTopic ?? "");
}

function channelTextForClaim(channel: any, where: ClaimWhere): string {
    const name = String(channel?.name ?? "");
    const topic = getChannelTopic(channel);

    if (where === "name") return name;
    if (where === "topic") return topic;

    return `${name}\n${topic}`;
}

function channelMatchesClaim(channel: any): boolean {
    const emoji = String(settings.store.claimEmoji ?? "").trim();
    const categoryId = String(settings.store.categoryId ?? "").trim();
    const scoped = Boolean(settings.store.claimOnlyInWatchedCategory);

    if (!emoji) return false;
    if (!channel?.id) return false;
    if (channel.type === 4) return false;
    if (scoped && !categoryId) return false;
    if (scoped && channel.parent_id !== categoryId) return false;

    const where = (settings.store.claimWhere ?? "either") as ClaimWhere;
    const haystack = channelTextForClaim(channel, where);

    return haystack.includes(emoji);
}

function isClaimedChannel(channelId: string): boolean {
    const channel = ChannelStore.getChannel(channelId) as any;

    if (!channel) return false;

    return channelMatchesClaim(channel);
}

function getClaimedTicketChannels(): ClaimedTicketInfo[] {
    const guildId = getGuildIdForTicketSearch();

    if (!guildId) return [];

    return getGuildChannels(guildId)
        .filter(channelMatchesClaim)
        .map(channel => ({
            id: String(channel.id),
            guildId,
            name: String(channel.name ?? channel.id),
            topic: getChannelTopic(channel),
            position: Number(channel.position ?? 0)
        }))
        .sort((a, b) => {
            const positionDiff = a.position - b.position;

            if (positionDiff !== 0) return positionDiff;

            return a.name.localeCompare(b.name);
        });
}

function getTicketPath(ticket: ClaimedTicketInfo): string {
    return `/channels/${ticket.guildId}/${ticket.id}`;
}

function getTicketLink(ticket: ClaimedTicketInfo): string {
    return `https://discord.com${getTicketPath(ticket)}`;
}

function openTicket(ticket: ClaimedTicketInfo): void {
    const transitionToChannel = (ChannelRouter as any)?.transitionToChannel;

    if (typeof transitionToChannel === "function") {
        transitionToChannel(ticket.id);
        return;
    }

    const link = document.querySelector(`a[href="${getTicketPath(ticket)}"]`) as HTMLAnchorElement | null;

    if (link) {
        link.click();
        return;
    }

    window.location.href = getTicketLink(ticket);
}

async function copyTicketLink(ticket: ClaimedTicketInfo): Promise<boolean> {
    const clipboard = navigator.clipboard;

    if (!clipboard) return false;

    try {
        await clipboard.writeText(getTicketLink(ticket));
        return true;
    } catch {
        return false;
    }
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

    const channel = extractChannel(action);

    if (!channel) return;

    const categoryId = String(settings.store.categoryId ?? "").trim();

    if (!categoryId) return;
    if (!settings.store.playOnNewChannel) return;
    if (channel.parent_id !== categoryId) return;
    if (channel.type === 4) return;

    parentByChannelId.set(channel.id, channel.parent_id ?? null);

    const now = Date.now();
    const cooldown = Number(settings.store.newChannelCooldownMs ?? 0);

    if (shouldThrottle(now, lastNewChannelSoundAt, cooldown)) return;

    lastNewChannelSoundAt = now;

    const kind = settings.store.newChannelSound as SoundKind;
    const url = String(settings.store.newChannelSoundUrl ?? "");
    const volume = Number(settings.store.newChannelVolume ?? 0.6);

    playSound(kind, url, volume);
}

function onChannelUpdate(action: any): void {
    if (!settings.store.enabled) return;

    refreshSnapshotIfNeeded();

    const channel = extractChannel(action);

    if (!channel) return;

    const categoryId = String(settings.store.categoryId ?? "").trim();

    if (!categoryId) return;

    const prevParent = parentByChannelId.get(channel.id) ?? null;
    const nextParent = (channel.parent_id ?? null) as string | null;

    parentByChannelId.set(channel.id, nextParent);

    if (!settings.store.playOnMovedIntoCategory) return;
    if (!settings.store.playOnNewChannel) return;
    if (prevParent === categoryId) return;
    if (nextParent !== categoryId) return;
    if (channel.type === 4) return;

    const now = Date.now();
    const cooldown = Number(settings.store.newChannelCooldownMs ?? 0);

    if (shouldThrottle(now, lastNewChannelSoundAt, cooldown)) return;

    lastNewChannelSoundAt = now;

    const kind = settings.store.newChannelSound as SoundKind;
    const url = String(settings.store.newChannelSoundUrl ?? "");
    const volume = Number(settings.store.newChannelVolume ?? 0.6);

    playSound(kind, url, volume);
}

function onMessageCreate(event: any): void {
    if (!settings.store.enabled) return;
    if (event?.type !== "MESSAGE_CREATE") return;
    if (event.optimistic) return;

    const message = event.message;

    if (!message) return;
    if (message.state === "SENDING") return;

    const ignoreBots = Boolean(settings.store.ignoreBots);

    if (ignoreBots && message.author?.bot) return;

    const ignoreSelf = Boolean(settings.store.ignoreSelf);
    const me = ignoreSelf ? UserStore.getCurrentUser?.() : null;
    const myId = me?.id;

    if (ignoreSelf && myId && message.author?.id === myId) return;

    const channelId = String(event.channelId ?? "");

    if (!channelId) return;
    if (!shouldPlayMessageSound(channelId)) return;

    const now = Date.now();
    const cooldown = Number(settings.store.messageCooldownMs ?? 0);

    if (shouldThrottle(now, lastMessageSoundAt, cooldown)) return;

    lastMessageSoundAt = now;

    const kind = settings.store.messageSound as SoundKind;
    const url = String(settings.store.messageSoundUrl ?? "");
    const volume = Number(settings.store.messageVolume ?? 0.7);

    playSound(kind, url, volume);
}

function SmallButton(props: {
    children: any;
    kind?: "primary" | "secondary" | "danger";
    onClick: () => void;
}): JSX.Element {
    const kind = props.kind ?? "secondary";
    const background = kind === "primary" ? UI.brand : UI.panelBgAlt;
    const border = kind === "primary" ? UI.brand : UI.border;

    return (
        <button
            onClick={props.onClick}
            style={{
                background,
                border: `1px solid ${border}`,
                borderRadius: "8px",
                color: UI.text,
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: 700,
                minHeight: "32px",
                padding: "6px 12px"
            }}
        >
            {props.children}
        </button>
    );
}

function TicketRow(props: {
    ticket: ClaimedTicketInfo;
    onOpen: () => void;
}): JSX.Element {
    const [copied, setCopied] = useState(false);
    const ticket = props.ticket;
    const topic = ticket.topic.trim();

    async function onCopy(): Promise<void> {
        const success = await copyTicketLink(ticket);

        setCopied(success);

        window.setTimeout(() => setCopied(false), 1300);
    }

    return (
        <div
            style={{
                alignItems: "center",
                background: UI.panelBg,
                border: `1px solid ${UI.border}`,
                borderRadius: "12px",
                display: "grid",
                gap: "14px",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                padding: "12px 14px"
            }}
        >
            <div style={{ minWidth: 0 }}>
                <div
                    style={{
                        alignItems: "center",
                        color: UI.text,
                        display: "flex",
                        fontSize: "15px",
                        fontWeight: 800,
                        gap: "6px",
                        lineHeight: "20px"
                    }}
                >
                    <span style={{ color: UI.muted }}>#</span>

                    <span
                        style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap"
                        }}
                    >
                        {ticket.name}
                    </span>
                </div>

                <div
                    style={{
                        color: UI.muted,
                        fontSize: "12px",
                        lineHeight: "18px",
                        marginTop: "3px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                    }}
                >
                    {topic || ticket.id}
                </div>
            </div>

            <div
                style={{
                    display: "flex",
                    flexShrink: 0,
                    gap: "8px"
                }}
            >
                <SmallButton onClick={onCopy}>
                    {copied ? "Copied" : "Copy"}
                </SmallButton>

                <SmallButton kind="primary" onClick={props.onOpen}>
                    Open
                </SmallButton>
            </div>
        </div>
    );
}

function ClaimedTicketsModal(props: {
    modalProps: ModalProps;
    onClose: () => void;
}): JSX.Element {
    const [query, setQuery] = useState("");
    const [tickets, setTickets] = useState(getClaimedTicketChannels);

    const emoji = String(settings.store.claimEmoji ?? "").trim();
    const categoryId = String(settings.store.categoryId ?? "").trim();
    const claimWhere = String(settings.store.claimWhere ?? "either");
    const scoped = Boolean(settings.store.claimOnlyInWatchedCategory);
    const queryLower = query.trim().toLowerCase();

    const visibleTickets = queryLower
        ? tickets.filter(ticket => {
            const haystack = `${ticket.name}\n${ticket.topic}\n${ticket.id}`.toLowerCase();

            return haystack.includes(queryLower);
        })
        : tickets;

    return (
        <ModalRoot {...props.modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <div
                    style={{
                        alignItems: "center",
                        background: UI.modalBg,
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%"
                    }}
                >
                    <div>
                        <div
                            style={{
                                color: UI.text,
                                fontSize: "21px",
                                fontWeight: 900,
                                lineHeight: "26px"
                            }}
                        >
                            Claimed Tickets {emoji}
                        </div>

                        <div
                            style={{
                                color: UI.muted,
                                fontSize: "13px",
                                lineHeight: "18px",
                                marginTop: "3px"
                            }}
                        >
                            {visibleTickets.length} of {tickets.length} tickets shown
                        </div>
                    </div>

                    <ModalCloseButton onClick={props.onClose} />
                </div>
            </ModalHeader>

            <ModalContent>
                <div
                    style={{
                        background: UI.panelBgAlt,
                        border: `1px solid ${UI.border}`,
                        borderRadius: "12px",
                        color: UI.muted,
                        display: "grid",
                        gap: "4px",
                        marginBottom: "12px",
                        padding: "12px 14px"
                    }}
                >
                    <div>
                        Category ID:{" "}
                        <span style={{ color: UI.text }}>
                            {categoryId || "not set"}
                        </span>
                    </div>

                    <div>
                        Scope:{" "}
                        <span style={{ color: UI.text }}>
                            {scoped ? "watched category only" : "current guild"}
                        </span>
                    </div>

                    <div>
                        Claim source:{" "}
                        <span style={{ color: UI.text }}>
                            {claimWhere}
                        </span>
                    </div>
                </div>

                <input
                    placeholder="Search ticket name, topic, or channel ID"
                    value={query}
                    onChange={(event: any) => setQuery(event.currentTarget.value)}
                    style={{
                        background: UI.inputBg,
                        border: `1px solid ${UI.border}`,
                        borderRadius: "10px",
                        boxSizing: "border-box",
                        color: UI.text,
                        fontSize: "14px",
                        marginBottom: "12px",
                        outline: "none",
                        padding: "12px 14px",
                        width: "100%"
                    }}
                />

                {visibleTickets.length === 0 && (
                    <div
                        style={{
                            background: UI.panelBg,
                            border: `1px solid ${UI.border}`,
                            borderRadius: "12px",
                            color: UI.muted,
                            padding: "20px",
                            textAlign: "center"
                        }}
                    >
                        No claimed tickets found. Check the emoji, category ID, and claim source setting.
                    </div>
                )}

                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                        maxHeight: "430px",
                        overflowY: "auto",
                        paddingRight: "4px"
                    }}
                >
                    {visibleTickets.map(ticket => (
                        <TicketRow
                            key={ticket.id}
                            ticket={ticket}
                            onOpen={() => {
                                props.onClose();
                                openTicket(ticket);
                            }}
                        />
                    ))}
                </div>
            </ModalContent>

            <ModalFooter>
                <div
                    style={{
                        display: "flex",
                        gap: "8px",
                        justifyContent: "flex-end",
                        width: "100%"
                    }}
                >
                    <SmallButton onClick={props.onClose}>
                        Close
                    </SmallButton>

                    <SmallButton
                        kind="primary"
                        onClick={() => setTickets(getClaimedTicketChannels())}
                    >
                        Refresh
                    </SmallButton>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

function openClaimedTicketsModal(): void {
    const key = openModal(modalProps => (
        <ClaimedTicketsModal
            modalProps={modalProps}
            onClose={() => closeModal(key)}
        />
    ));
}

function SettingsAboutComponent(): JSX.Element {
    return (
        <div
            style={{
                background: UI.panelBg,
                border: `1px solid ${UI.border}`,
                borderRadius: "12px",
                color: UI.text,
                marginTop: "16px",
                padding: "14px"
            }}
        >
            <div
                style={{
                    fontSize: "15px",
                    fontWeight: 800,
                    marginBottom: "4px"
                }}
            >
                Claimed Ticket Viewer
            </div>

            <div
                style={{
                    color: UI.muted,
                    fontSize: "13px",
                    lineHeight: "18px",
                    marginBottom: "12px"
                }}
            >
                Use /claimedtickets to open the viewer without sending a message.
            </div>

            <SmallButton kind="primary" onClick={openClaimedTicketsModal}>
                Open Ticket Viewer
            </SmallButton>
        </div>
    );
}

export default definePlugin({
    name: "NrcTicketUtil",
    description: "Plays configurable sounds for new ticket channels and for new messages in channels claimed by your emoji.",
    authors: [{ name: "Brentspine" }],
    dependencies: ["CommandsAPI"],
    settings,

    settingsAboutComponent() {
        return <SettingsAboutComponent />;
    },

    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "claimedtickets",
            description: "Show all tickets claimed with your configured emoji",
            options: [],
            execute: () => {
                openClaimedTicketsModal();
            }
        }
    ],

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
