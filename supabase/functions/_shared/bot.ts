import { type Adapter, Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { getConfigString } from "./helpers.ts";

export function createChatBot(): { bot: Chat; adapters: Record<string, Adapter> } {
  const adapters: Record<string, Adapter> = {};

  const slackToken = Deno.env.get("SLACK_BOT_TOKEN");
  const slackSecret = Deno.env.get("SLACK_SIGNING_SECRET");
  if (slackToken && slackSecret) {
    adapters.slack = createSlackAdapter({
      botToken: slackToken,
      signingSecret: slackSecret,
    });
  }

  const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const telegramSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (telegramToken && telegramSecret) {
    adapters.telegram = createTelegramAdapter({
      botToken: telegramToken,
      secretToken: telegramSecret,
    });
  }

  const teamsAppId = Deno.env.get("TEAMS_APP_ID");
  const teamsAppPassword = Deno.env.get("TEAMS_APP_PASSWORD");
  if (teamsAppId && teamsAppPassword) {
    const appType = Deno.env.get("TEAMS_APP_TYPE") === "SingleTenant"
      ? "SingleTenant"
      : "MultiTenant";
    const teamsTenantId = Deno.env.get("TEAMS_APP_TENANT_ID");
    adapters.teams = createTeamsAdapter({
      appId: teamsAppId,
      appPassword: teamsAppPassword,
      appType,
      appTenantId: appType === "SingleTenant" ? teamsTenantId : undefined,
    });
  }

  const discordBotToken = Deno.env.get("DISCORD_BOT_TOKEN");
  const discordPublicKey = Deno.env.get("DISCORD_PUBLIC_KEY");
  const discordApplicationId = Deno.env.get("DISCORD_APPLICATION_ID");
  if (discordBotToken && discordPublicKey && discordApplicationId) {
    adapters.discord = createDiscordAdapter({
      botToken: discordBotToken,
      publicKey: discordPublicKey,
      applicationId: discordApplicationId,
      mentionRoleIds: Deno.env.get("DISCORD_MENTION_ROLE_IDS")
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    });
  }

  const bot = new Chat({
    userName: getConfigString("agent.name") ?? "supaclaw",
    adapters,
    state: createMemoryState(),
  });

  return { bot, adapters };
}

