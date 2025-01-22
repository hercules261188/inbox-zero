import { describe, expect, test, vi } from "vitest";
import stripIndent from "strip-indent";
import { processUserRequest } from "@/utils/ai/assistant/fix-rules";
import type { ParsedMessage, ParsedMessageHeaders } from "@/utils/types";
import type { RuleWithRelations } from "@/utils/ai/rule/create-prompt-from-rule";
import {
  type Group,
  type Category,
  type GroupItem,
  RuleType,
} from "@prisma/client";
import { GroupItemType, LogicalOperator } from "@prisma/client";

// pnpm test-ai ai-fix-rules

const isAiTest = process.env.RUN_AI_TESTS === "true";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/gmail/mail", () => ({ replyToEmail: vi.fn() }));

describe(
  "processUserRequest",
  {
    timeout: 30_000,
    skip: !isAiTest,
  },
  () => {
    test("should fix a rule with incorrect AI instructions", async () => {
      const rule = getRule({
        name: "Partnership Rule",
        instructions: "Match emails discussing business opportunities",
      });

      const userRequestEmail = getParsedMessage({
        textPlain: "This is a promotional email",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "sales@company.com",
          subject: "Special Offer for Your Business",
        },
        textPlain: stripIndent(`
        Hi there,

        We have an amazing product that could boost your revenue by 300%.
        Special discount available this week only!

        Let me know if you'd like a demo.

        Best,
        Sales Team
      `),
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [rule],
        userRequestEmail,
        originalEmail,
        matchedRule: rule,
        gmail: {} as any,
        categories: null,
        senderCategory: null,
      });

      expect(result).toBeDefined();

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);
      const fixRuleToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "edit_rule",
      );

      expect(fixRuleToolCall).toBeDefined();
      expect(fixRuleToolCall?.args.ruleName).toBe("Partnership Rule");
    });

    test("should handle request to fix rule categorization", async () => {
      const ruleSupport = getRule({
        name: "Support Rule",
        instructions: "Match technical support requests",
      });
      const ruleUrgent = getRule({
        name: "Urgent Rule",
        instructions: "Match urgent requests",
      });

      const userRequestEmail = getParsedMessage({
        textPlain: "This isn't urgent.",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "user@test.com",
          subject: "Help with Login",
        },
        textPlain: stripIndent(`
        Hello,

        I can't log into my account. Can someone help?

        Thanks,
        User
      `),
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [ruleSupport, ruleUrgent],
        userRequestEmail,
        originalEmail,
        matchedRule: ruleUrgent,
        gmail: {} as any,
        categories: null,
        senderCategory: null,
      });

      expect(result).toBeDefined();

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);

      const fixRuleToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "edit_rule",
      );

      expect(fixRuleToolCall).toBeDefined();
      expect(fixRuleToolCall?.args.ruleName).toBe("Urgent Rule");
    });

    test("should fix static conditions when user indicates incorrect matching", async () => {
      const rule = getRule({
        name: "Receipt Rule",
        from: "@amazon.com",
        subject: "Order",
      });

      const userRequestEmail = getParsedMessage({
        textPlain: "This isn't a receipt, it's a shipping notification.",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "shipping@amazon.com",
          subject: "Order #123 Has Shipped",
        },
        textPlain: stripIndent(`
          Your order has shipped!
          Tracking number: 1234567890
          Expected delivery: Tomorrow
        `),
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [rule],
        userRequestEmail,
        originalEmail,
        matchedRule: rule,
        gmail: {} as any,
        categories: null,
        senderCategory: null,
      });

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);
      const fixRuleToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "edit_rule",
      );

      expect(fixRuleToolCall).toBeDefined();
      expect(fixRuleToolCall?.args.ruleName).toBe("Receipt Rule");
      expect(
        fixRuleToolCall?.args.condition?.static?.subject?.includes(
          "shipping",
        ) ||
          fixRuleToolCall?.args.condition?.aiInstructions?.includes("shipping"),
      ).toBe(true);
    });

    test("should fix group conditions when user reports incorrect matching", async () => {
      const group = getGroup({
        id: "group1",
        name: "Newsletters",
      });
      const groupItems = [
        getGroupItem({
          id: "1",
          type: GroupItemType.FROM,
          value: "david@hello.com",
        }),
        getGroupItem({
          id: "2",
          type: GroupItemType.FROM,
          value: "@beehiiv.com",
        }),
      ];

      const rule = getRule({
        name: "Newsletter Rule",
        groupId: group.id,
        group,
        groupItems,
      });

      const userRequestEmail = getParsedMessage({
        textPlain: "This isn't a newsletter",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "david@hello.com",
          subject: "Question about your latest post",
        },
        textPlain: stripIndent(`
          Hey there,

          Thanks for reaching out about my article on microservices. You raised some 
          really interesting points about the scalability challenges you're facing.

          I actually dealt with a similar issue at my previous company. Would love to 
          hop on a quick call to discuss it in more detail.

          Best,
          David
        `),
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [rule],
        userRequestEmail,
        originalEmail,
        matchedRule: rule,
        gmail: {} as any,
        categories: null,
        senderCategory: null,
      });

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);
      const removeFromGroupToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "remove_from_group",
      );

      expect(removeFromGroupToolCall).toBeDefined();
      expect(removeFromGroupToolCall?.args.value).toBe("david@hello.com");
    });

    test("should suggest adding sender to group when identified as missing", async () => {
      const group = getGroup({
        id: "group1",
        name: "Newsletters",
      });
      const groupItems = [
        getGroupItem({
          id: "1",
          type: GroupItemType.FROM,
          value: "ainewsletter@substack.com",
        }),
        getGroupItem({
          id: "2",
          type: GroupItemType.FROM,
          value: "milkroad@beehiiv.com",
        }),
      ];

      const rule = getRule({
        name: "Newsletter Rule",
        groupId: group.id,
        group,
        groupItems,
      });

      const userRequestEmail = getParsedMessage({
        textPlain: "This is a newsletter",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "mattsnews@convertkit.com",
          to: "me@ourcompany.com",
          subject: "Weekly Developer Digest",
        },
        textPlain: stripIndent(`
          This Week's Top Stories:
          
          1. The Future of TypeScript
          2. React Server Components Deep Dive
          3. Building Scalable Systems
          
          To unsubscribe, click here
          Powered by ConvertKit
        `),
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [rule],
        userRequestEmail,
        originalEmail,
        matchedRule: null, // Important: rule didn't match initially
        gmail: {} as any,
        categories: null,
        senderCategory: null,
      });

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);
      const addToGroupToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "add_to_group",
      );

      expect(addToGroupToolCall).toBeDefined();
      expect(addToGroupToolCall?.args.type).toBe("from");
      expect(addToGroupToolCall?.args.value).toContain("convertkit.com");
    });

    test("should fix category filters when user indicates wrong categorization", async () => {
      const marketingCategory = getCategory({
        name: "Marketing",
        description: "Marketing related emails",
      });

      const rule = getRule({
        name: "Marketing Rule",
        categoryFilterType: "INCLUDE",
        categoryFilters: [marketingCategory],
      });

      const userRequestEmail = getParsedMessage({
        textPlain: "This is actually a sales email, not marketing.",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "marketing@company.com",
          subject: "Special Offer",
        },
        textPlain: "Would you like to purchase our enterprise plan?",
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [rule],
        userRequestEmail,
        originalEmail,
        matchedRule: rule,
        gmail: {} as any,
        categories: ["Marketing", "Sales", "Newsletter"],
        senderCategory: "Marketing",
      });

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);
      const changeSenderCategoryToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "change_sender_category",
      );

      expect(changeSenderCategoryToolCall).toBeDefined();
      expect(changeSenderCategoryToolCall?.args.category).toBe("Sales");
    });

    test("should handle complex rule fixes with multiple condition types", async () => {
      const salesCategory = getCategory({
        name: "Sales",
        description: "Sales related emails",
      });

      const rule = getRule({
        name: "Sales Rule",
        instructions: "Match sales opportunities",
        from: "@enterprise.com",
        subject: "Business opportunity",
        categoryFilters: [salesCategory],
        categoryFilterType: "INCLUDE",
      });

      const userRequestEmail = getParsedMessage({
        textPlain:
          "This is a spam email pretending to be a business opportunity.",
      });

      const originalEmail = getParsedMessage({
        headers: {
          from: "contact@enterprise.com",
          subject: "Business opportunity - Act now!",
        },
        textPlain: "Make millions with this amazing opportunity!",
      });

      const result = await processUserRequest({
        user: getUser(),
        rules: [rule],
        userRequestEmail,
        originalEmail,
        matchedRule: rule,
        gmail: {} as any,
        categories: ["Marketing", "Sales", "Newsletter"],
        senderCategory: "Marketing",
      });

      const toolCalls = result.steps.flatMap((step) => step.toolCalls);
      const fixRuleToolCall = toolCalls.find(
        (toolCall) => toolCall.toolName === "edit_rule",
      );

      expect(fixRuleToolCall).toBeDefined();
      expect(fixRuleToolCall?.args.ruleName).toBe("Sales Rule");
    });
  },
);

function getRule(rule: Partial<RuleWithRelations>): RuleWithRelations {
  return {
    id: "1",
    userId: "user1",
    name: "Rule name",

    conditionalOperator: LogicalOperator.AND,
    // ai instructions
    instructions: null,
    // static conditions
    from: null,
    to: null,
    subject: null,
    body: null,
    // group conditions
    group: null,
    groupId: null,
    // category conditions
    categoryFilters: [],
    categoryFilterType: null,

    // other
    actions: [],
    automate: true,
    runOnThreads: true,
    enabled: true,
    type: RuleType.AI,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...rule,
  };
}

function getParsedMessage(
  message: Omit<Partial<ParsedMessage>, "headers"> & {
    headers?: Partial<ParsedMessageHeaders>;
  },
): ParsedMessage {
  return {
    id: "id",
    threadId: "thread-id",
    snippet: "",
    attachments: [],
    historyId: "history-id",
    sizeEstimate: 100,
    internalDate: new Date().toISOString(),
    inline: [],
    textPlain: "",
    ...message,
    headers: {
      from: "test@example.com",
      to: "recipient@example.com",
      subject: "",
      date: new Date().toISOString(),
      references: "",
      "message-id": "message-id",
      ...message.headers,
    },
  };
}

function getUser() {
  return {
    id: "user1",
    aiModel: null,
    aiProvider: null,
    email: "user@test.com",
    aiApiKey: null,
    about: null,
  };
}

function getGroup(group: Partial<Group>): Group {
  return {
    id: "group1",
    name: "Group name",
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: "user1",
    prompt: null,
    ...group,
  };
}

function getGroupItem(item: Partial<GroupItem>): GroupItem {
  return {
    id: "id",
    value: "",
    type: GroupItemType.FROM,
    createdAt: new Date(),
    updatedAt: new Date(),
    groupId: "group1",
    ...item,
  };
}

function getCategory(category: Partial<Category>): Category {
  return {
    id: "id",
    name: "",
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: "user1",
    ...category,
  };
}
