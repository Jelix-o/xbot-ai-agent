import { defineStore } from "pinia";
import { computed, reactive, shallowRef } from "vue";
import { api, jsonOptions } from "../services/api";
import type {
  AdminOperationLogEntry,
  Overview,
  PersonalKnowledgeEntry,
  PersonalMemory,
  PersonalMemoryCandidate,
  PersonalReminderTask,
  PrivateBotConfig,
  SkillDefinition,
  SystemHealthStatus,
  SystemSettings,
} from "../types";

export const useAdminStore = defineStore("admin", () => {
  const loading = shallowRef(false);
  const error = shallowRef("");
  const authenticated = shallowRef(false);
  const authChecked = shallowRef(false);
  const authUser = shallowRef("");
  const activeUserId = shallowRef("");
  const overview = shallowRef<Overview | null>(null);
  const users = shallowRef<PrivateBotConfig[]>([]);
  const skills = shallowRef<SkillDefinition[]>([]);
  const memories = shallowRef<PersonalMemory[]>([]);
  const candidates = shallowRef<PersonalMemoryCandidate[]>([]);
  const knowledge = shallowRef<PersonalKnowledgeEntry[]>([]);
  const reminders = shallowRef<PersonalReminderTask[]>([]);
  const logs = shallowRef<AdminOperationLogEntry[]>([]);
  const systemSettings = shallowRef<SystemSettings | null>(null);
  const health = shallowRef<SystemHealthStatus | null>(null);
  const userForm = reactive({
    userId: "",
    displayName: "",
    currentSkillId: "itexpert",
    allowedSkillIds: "itexpert,leijun,jackma,zxp",
  });
  const knowledgeForm = reactive({
    id: "",
    title: "",
    question: "",
    answer: "",
    keywords: "",
    enabled: true,
  });
  const loginForm = reactive({
    username: "admin",
    password: "",
  });

  const activeUser = computed(() => users.value.find((user) => user.userId === activeUserId.value) ?? users.value[0]);
  const pendingCandidates = computed(() => candidates.value.filter((candidate) => candidate.status === "pending"));

  async function checkSession(): Promise<void> {
    try {
      const data = await api<{ authenticated: boolean; username?: string }>("/api/session");
      authenticated.value = data.authenticated;
      authUser.value = data.username ?? "";
      if (authenticated.value) await loadAll();
    } catch {
      authenticated.value = false;
      authUser.value = "";
    } finally {
      authChecked.value = true;
    }
  }

  async function login(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const data = await api<{ ok: boolean; username: string }>("/api/login", jsonOptions("POST", {
        username: loginForm.username.trim(),
        password: loginForm.password,
      }));
      authenticated.value = data.ok;
      authUser.value = data.username;
      loginForm.password = "";
      await loadAll();
    } catch {
      error.value = "登录失败，请检查用户名和密码。";
      authenticated.value = false;
    } finally {
      loading.value = false;
      authChecked.value = true;
    }
  }

  async function logout(): Promise<void> {
    await api<{ ok: boolean }>("/api/logout", jsonOptions("POST", {}));
    authenticated.value = false;
    authUser.value = "";
    overview.value = null;
    users.value = [];
    skills.value = [];
    memories.value = [];
    candidates.value = [];
    knowledge.value = [];
    reminders.value = [];
    logs.value = [];
    systemSettings.value = null;
    health.value = null;
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const [overviewData, usersData, skillsData] = await Promise.all([
        api<Overview>("/api/overview"),
        api<{ users: PrivateBotConfig[] }>("/api/users"),
        api<{ skills: SkillDefinition[] }>("/api/skills"),
      ]);
      overview.value = overviewData;
      logs.value = overviewData.logs ?? [];
      health.value = overviewData.health;
      users.value = usersData.users;
      skills.value = skillsData.skills;
      if (!activeUserId.value && users.value[0]) activeUserId.value = users.value[0].userId;
      await Promise.all([loadUserScoped(), loadSystemSettings()]);
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadUserScoped(): Promise<void> {
    const suffix = activeUserId.value ? `?userId=${encodeURIComponent(activeUserId.value)}` : "";
    const [memoriesData, candidatesData, knowledgeData] = await Promise.all([
      api<{ memories: PersonalMemory[] }>(`/api/memories${suffix}`),
      api<{ candidates: PersonalMemoryCandidate[] }>(`/api/memory-candidates${suffix}`),
      api<{ entries: PersonalKnowledgeEntry[] }>(`/api/knowledge${suffix}`),
    ]);
    memories.value = memoriesData.memories;
    candidates.value = candidatesData.candidates;
    knowledge.value = knowledgeData.entries;
    reminders.value = activeUserId.value
      ? (await api<{ tasks: PersonalReminderTask[] }>(`/api/reminders?userId=${encodeURIComponent(activeUserId.value)}`)).tasks
      : [];
  }

  async function saveUser(user: PrivateBotConfig): Promise<void> {
    await api(`/api/users/${encodeURIComponent(user.userId)}`, jsonOptions("PATCH", user));
    await loadAll();
  }

  async function createUser(): Promise<void> {
    await api("/api/users", jsonOptions("POST", {
      userId: userForm.userId.trim(),
      displayName: userForm.displayName.trim() || undefined,
      currentSkillId: userForm.currentSkillId.trim(),
      allowedSkillIds: userForm.allowedSkillIds.split(",").map((item) => item.trim()).filter(Boolean),
    }));
    userForm.userId = "";
    userForm.displayName = "";
    await loadAll();
  }

  async function approveCandidate(candidate: PersonalMemoryCandidate): Promise<void> {
    await api(`/api/memory-candidates/${encodeURIComponent(candidate.id)}/approve`, jsonOptions("POST", candidate));
    await loadUserScoped();
  }

  async function rejectCandidate(candidate: PersonalMemoryCandidate): Promise<void> {
    await api(`/api/memory-candidates/${encodeURIComponent(candidate.id)}/reject`, jsonOptions("POST", {}));
    await loadUserScoped();
  }

  async function toggleMemory(memory: PersonalMemory): Promise<void> {
    await api(`/api/memories/${encodeURIComponent(memory.id)}`, jsonOptions("PATCH", { enabled: !memory.enabled }));
    await loadUserScoped();
  }

  async function saveMemory(memory: PersonalMemory): Promise<void> {
    await api(`/api/memories/${encodeURIComponent(memory.id)}`, jsonOptions("PATCH", memory));
    await loadUserScoped();
  }

  async function toggleKnowledge(entry: PersonalKnowledgeEntry): Promise<void> {
    await api(`/api/knowledge/${encodeURIComponent(entry.id)}`, jsonOptions("PATCH", { enabled: !entry.enabled }));
    await loadUserScoped();
  }

  function editKnowledge(entry: PersonalKnowledgeEntry): void {
    knowledgeForm.id = entry.id;
    knowledgeForm.title = entry.title;
    knowledgeForm.question = entry.question;
    knowledgeForm.answer = entry.answer;
    knowledgeForm.keywords = entry.keywords.join(", ");
    knowledgeForm.enabled = entry.enabled;
  }

  function resetKnowledgeForm(): void {
    knowledgeForm.id = "";
    knowledgeForm.title = "";
    knowledgeForm.question = "";
    knowledgeForm.answer = "";
    knowledgeForm.keywords = "";
    knowledgeForm.enabled = true;
  }

  async function saveKnowledge(): Promise<void> {
    if (!activeUserId.value) return;
    const payload = {
      userId: activeUserId.value,
      title: knowledgeForm.title.trim(),
      question: knowledgeForm.question.trim(),
      answer: knowledgeForm.answer.trim(),
      keywords: knowledgeForm.keywords.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean),
      enabled: knowledgeForm.enabled,
    };
    if (knowledgeForm.id) {
      await api(`/api/knowledge/${encodeURIComponent(knowledgeForm.id)}`, jsonOptions("PATCH", payload));
    } else {
      await api("/api/knowledge", jsonOptions("POST", payload));
    }
    resetKnowledgeForm();
    await loadUserScoped();
  }

  async function deleteKnowledge(entry: PersonalKnowledgeEntry): Promise<void> {
    await api(`/api/knowledge/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    if (knowledgeForm.id === entry.id) resetKnowledgeForm();
    await loadUserScoped();
  }

  async function loadSystemSettings(): Promise<void> {
    const data = await api<{ settings: SystemSettings }>("/api/system-settings");
    systemSettings.value = data.settings;
  }

  async function saveSystemSettings(): Promise<void> {
    if (!systemSettings.value) return;
    const data = await api<{ settings: SystemSettings }>("/api/system-settings", jsonOptions("PATCH", systemSettings.value));
    systemSettings.value = data.settings;
    await refreshHealth();
  }

  async function refreshHealth(): Promise<void> {
    health.value = await api<SystemHealthStatus>("/api/health?refresh=1");
  }

  return {
    loading,
    error,
    authenticated,
    authChecked,
    authUser,
    activeUserId,
    activeUser,
    overview,
    users,
    skills,
    memories,
    candidates,
    pendingCandidates,
    knowledge,
    reminders,
    logs,
    systemSettings,
    health,
    userForm,
    knowledgeForm,
    loginForm,
    checkSession,
    login,
    logout,
    loadAll,
    loadUserScoped,
    saveUser,
    createUser,
    approveCandidate,
    rejectCandidate,
    toggleMemory,
    saveMemory,
    toggleKnowledge,
    editKnowledge,
    resetKnowledgeForm,
    saveKnowledge,
    deleteKnowledge,
    loadSystemSettings,
    saveSystemSettings,
    refreshHealth,
  };
});
