const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed...');

  // Organização
  const org = await prisma.organization.upsert({
    where:  { slug: 'coren-demo' },
    update: {},
    create: { name: 'COREN Demo', slug: 'coren-demo', settings: {} },
  });

  // Admin
  const adminHash = await bcrypt.hash('Admin@1234', 12);
  const admin = await prisma.user.upsert({
    where:  { email: 'admin@coren.demo' },
    update: {},
    create: {
      organizationId: org.id,
      email:        'admin@coren.demo',
      passwordHash: adminHash,
      name:         'Administrador',
      role:         'ADMIN',
    },
  });

  // Agente de teste
  const agentHash = await bcrypt.hash('Agente@1234', 12);
  await prisma.user.upsert({
    where:  { email: 'agente@coren.demo' },
    update: {},
    create: {
      organizationId: org.id,
      email:        'agente@coren.demo',
      passwordHash: agentHash,
      name:         'Agente Teste',
      role:         'AGENT',
    },
  });

  // Settings padrão — inclui todas as novas chaves usadas pelo admin e pela extensão
  const defaultSettings = [
    // ── Modelo de IA ─────────────────────────────────
    { key: 'suggestion.model',          value: 'gpt-4o-mini' },
    { key: 'suggestion.temperature',    value: 0.7 },
    { key: 'suggestion.maxTokens',      value: 500 },

    // ── Aprendizado e qualidade ───────────────────────
    { key: 'suggestion.learnFromApproved',         value: true },
    { key: 'suggestion.filterRejected',            value: true },
    { key: 'suggestion.minApprovalScoreToLearn',   value: 0.8 },

    // ── Limites por usuário ───────────────────────────
    { key: 'limits.suggestionsPerUserPerDay',      value: 0 },   // 0 = ilimitado
    { key: 'limits.chatMessagesPerUserPerDay',     value: 0 },
    { key: 'limits.maxActiveSessions',             value: 3 },

    // ── Sessão e segurança ────────────────────────────
    { key: 'auth.sessionDurationHours',            value: 8 },
    { key: 'auth.maxLoginAttempts',                value: 10 },
    { key: 'auth.requireStrongPassword',           value: false },

    // ── Limpeza e retenção ────────────────────────────
    { key: 'retention.historyDays',                value: 90 },
    { key: 'retention.eventLogDays',               value: 90 },
    { key: 'retention.autoCleanRejected',          value: false },

    // ── Legado (compatibilidade com versão anterior) ──
    { key: 'learning.avoid_rejected',              value: true },
    { key: 'learning.use_templates',               value: true },
  ];

  for (const s of defaultSettings) {
    await prisma.setting.upsert({
      where:  { organizationId_key: { organizationId: org.id, key: s.key } },
      update: { value: s.value },
      create: { organizationId: org.id, ...s },
    });
  }

  // Knowledge bases
  await prisma.knowledgeBase.upsert({
    where:  { id: 'coren-kb-seed' },
    update: {},
    create: {
      id:             'coren-kb-seed',
      organizationId: org.id,
      name:           'coren',
      sourceUrl:      'https://raw.githubusercontent.com/clebermitho/base-de-conhecimento/refs/heads/main/base_coren.json',
      content:        {},
    },
  });

  console.log('✅ Seed concluído!');
  console.log(`   Org:    ${org.name} (${org.slug})`);
  console.log(`   Admin:  admin@coren.demo / Admin@1234`);
  console.log(`   Agente: agente@coren.demo / Agente@1234`);
  console.log(`   Settings: ${defaultSettings.length} chaves configuradas`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
