"use strict";

const {
    GuildScheduledEventEntityType,
    GuildScheduledEventPrivacyLevel,
} = require("discord.js");

function log(label, payload = undefined) {
    const stamp = new Date().toISOString();
    if (payload === undefined) {
        console.log(`[game-sessions] ${stamp} ${label}`);
        return;
    }
    console.log(`[game-sessions] ${stamp} ${label}`, JSON.stringify(payload, null, 2));
}

function requireGuild(context) {
    const guild = context?.guild;
    if (!guild) {
        throw new Error("Game sessions can only be managed from inside a Discord server.");
    }
    return guild;
}

function parseDate(value, fieldName) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) {
        throw new Error(`${fieldName} must be a valid ISO-8601 date/time with timezone offset.`);
    }
    return date;
}

function serializeEvent(event) {
    return {
        id: event.id,
        name: event.name,
        description: event.description || null,
        status: event.status,
        entityType: event.entityType,
        scheduledStartTime: event.scheduledStartAt?.toISOString() || null,
        scheduledEndTime: event.scheduledEndAt?.toISOString() || null,
        location: event.entityMetadata?.location || null,
        creatorId: event.creatorId || null,
        userCount: event.userCount ?? null,
        url: event.url || null,
    };
}

async function createGameSession(args, context) {
    const guild = requireGuild(context);
    const start = parseDate(args.start_time, "start_time");
    const durationMinutes = Number(args.duration_minutes || 180);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440) {
        throw new Error("duration_minutes must be between 15 and 1440.");
    }
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    const location = (args.location || "Discord").trim();

    const request = {
        name: args.name.trim(),
        description: args.description?.trim() || undefined,
        scheduledStartTime: start,
        scheduledEndTime: end,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location },
        reason: `Created by Vesper at request of ${context?.requesterTag || context?.requesterId || "Discord user"}`,
    };

    log("CREATE request", {
        guildId: guild.id,
        guildName: guild.name,
        requesterId: context?.requesterId,
        requesterTag: context?.requesterTag,
        channelId: context?.channelId,
        args,
        normalized: {
            ...request,
            scheduledStartTime: start.toISOString(),
            scheduledEndTime: end.toISOString(),
        },
    });

    try {
        const event = await guild.scheduledEvents.create(request);
        const result = serializeEvent(event);
        log("CREATE success", result);
        return { success: true, event: result };
    } catch (error) {
        log("CREATE failure", {
            message: error.message,
            name: error.name,
            code: error.code,
            status: error.status,
            method: error.method,
            url: error.url,
            rawError: error.rawError,
            stack: error.stack,
        });
        throw error;
    }
}

async function listGameSessions(args, context) {
    const guild = requireGuild(context);
    log("LIST request", {
        guildId: guild.id,
        guildName: guild.name,
        requesterId: context?.requesterId,
        include_completed: Boolean(args.include_completed),
    });

    try {
        const events = await guild.scheduledEvents.fetch();
        let results = [...events.values()].map(serializeEvent);
        if (!args.include_completed) {
            results = results.filter((event) => ![3, 4].includes(Number(event.status)));
        }
        results.sort((a, b) => new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime));
        log("LIST success", { count: results.length, events: results });
        return { success: true, count: results.length, events: results };
    } catch (error) {
        log("LIST failure", {
            message: error.message,
            name: error.name,
            code: error.code,
            status: error.status,
            rawError: error.rawError,
            stack: error.stack,
        });
        throw error;
    }
}

async function updateGameSession(args, context) {
    const guild = requireGuild(context);
    log("UPDATE request", {
        guildId: guild.id,
        guildName: guild.name,
        requesterId: context?.requesterId,
        args,
    });

    try {
        const event = await guild.scheduledEvents.fetch(args.event_id);
        if (!event) throw new Error(`Scheduled event ${args.event_id} was not found.`);

        const changes = {};
        if (args.name !== undefined) changes.name = args.name.trim();
        if (args.description !== undefined) changes.description = args.description.trim();
        if (args.location !== undefined) changes.entityMetadata = { location: args.location.trim() };

        if (args.start_time !== undefined) {
            const newStart = parseDate(args.start_time, "start_time");
            changes.scheduledStartTime = newStart;

            const oldStart = event.scheduledStartAt;
            const oldEnd = event.scheduledEndAt;
            const durationMs = oldStart && oldEnd
                ? Math.max(15 * 60_000, oldEnd.getTime() - oldStart.getTime())
                : 180 * 60_000;
            changes.scheduledEndTime = new Date(newStart.getTime() + durationMs);
        }

        if (args.duration_minutes !== undefined) {
            const durationMinutes = Number(args.duration_minutes);
            if (!Number.isFinite(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440) {
                throw new Error("duration_minutes must be between 15 and 1440.");
            }
            const effectiveStart = changes.scheduledStartTime || event.scheduledStartAt;
            if (!effectiveStart) throw new Error("Cannot set duration because the event has no start time.");
            changes.scheduledEndTime = new Date(effectiveStart.getTime() + durationMinutes * 60_000);
        }

        if (Object.keys(changes).length === 0) {
            throw new Error("No update fields were supplied.");
        }

        log("UPDATE normalized changes", {
            eventId: event.id,
            changes: {
                ...changes,
                scheduledStartTime: changes.scheduledStartTime?.toISOString(),
                scheduledEndTime: changes.scheduledEndTime?.toISOString(),
            },
        });

        const updated = await event.edit(changes, `Updated by Vesper at request of ${context?.requesterTag || context?.requesterId || "Discord user"}`);
        const result = serializeEvent(updated);
        log("UPDATE success", result);
        return { success: true, event: result };
    } catch (error) {
        log("UPDATE failure", {
            eventId: args.event_id,
            message: error.message,
            name: error.name,
            code: error.code,
            status: error.status,
            rawError: error.rawError,
            stack: error.stack,
        });
        throw error;
    }
}

async function deleteGameSession(args, context) {
    const guild = requireGuild(context);
    log("DELETE request", {
        guildId: guild.id,
        guildName: guild.name,
        requesterId: context?.requesterId,
        eventId: args.event_id,
    });

    try {
        const event = await guild.scheduledEvents.fetch(args.event_id);
        if (!event) throw new Error(`Scheduled event ${args.event_id} was not found.`);
        const beforeDelete = serializeEvent(event);
        await event.delete(`Deleted by Vesper at request of ${context?.requesterTag || context?.requesterId || "Discord user"}`);
        log("DELETE success", beforeDelete);
        return { success: true, deleted_event: beforeDelete };
    } catch (error) {
        log("DELETE failure", {
            eventId: args.event_id,
            message: error.message,
            name: error.name,
            code: error.code,
            status: error.status,
            rawError: error.rawError,
            stack: error.stack,
        });
        throw error;
    }
}

module.exports = {
    createGameSession,
    listGameSessions,
    updateGameSession,
    deleteGameSession,
};
