<script setup lang="ts">
import { computed, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useAdminStore } from "./stores/admin";

const admin = useAdminStore();
const {
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
} = storeToRefs(admin);

const activeAllowedSkillText = computed(() => activeUser.value?.allowedSkillIds.join(", ") ?? "");
const activeSkillName = computed(() => skills.value.find((skill) => skill.id === activeUser.value?.currentSkillId)?.name ?? activeUser.value?.currentSkillId ?? "-");
const modelPurposes = ["reply", "memory", "tts", "custom"] as const;
const healthModels = computed(() => health.value?.models ?? []);
const systemModels = computed(() => systemSettings.value?.models ?? []);
const operationLogs = computed(() => logs.value.slice(0, 8));

onMounted(() => {
  void admin.checkSession();
});

async function selectUser(userId: string): Promise<void> {
  activeUserId.value = userId;
  await admin.loadUserScoped();
}
</script>

<template>
  <main v-if="!authChecked" class="login-shell">
    <section class="login-panel">
      <strong>XBot</strong>
      <p>Loading admin console...</p>
    </section>
  </main>

  <main v-else-if="!authenticated" class="login-shell">
    <form class="login-panel" @submit.prevent="admin.login">
      <div class="brand login-brand">
        <strong>XBot</strong>
        <span>v1.1.0</span>
      </div>
      <h1>Admin Login</h1>
      <p>Sign in to manage private Agent users, memory, models, and health.</p>
      <label>
        Username
        <input v-model="loginForm.username" class="input" autocomplete="username" />
      </label>
      <label>
        Password
        <input v-model="loginForm.password" class="input" type="password" autocomplete="current-password" />
      </label>
      <p v-if="error" class="alert">{{ error }}</p>
      <button class="btn" type="submit" :disabled="loading || !loginForm.username.trim() || !loginForm.password">
        {{ loading ? "Signing in..." : "Sign in" }}
      </button>
    </form>
  </main>

  <main v-else class="admin-shell">
    <aside class="sidebar">
      <div class="brand">
        <strong>XBot</strong>
        <span>v1.1.0</span>
      </div>

      <section class="panel compact">
        <h2>Users</h2>
        <button
          v-for="user in users"
          :key="user.userId"
          class="user-row"
          :class="{ active: user.userId === activeUserId }"
          type="button"
          @click="selectUser(user.userId)"
        >
          <span>{{ user.displayName || user.userId }}</span>
          <small>{{ user.enabled === false ? "disabled" : user.currentSkillId }}</small>
        </button>
      </section>

      <section class="panel compact">
        <h2>Invite</h2>
        <input v-model="userForm.userId" class="input" placeholder="QQ userId" />
        <input v-model="userForm.displayName" class="input" placeholder="Display name" />
        <input v-model="userForm.currentSkillId" class="input" placeholder="Default skill" />
        <input v-model="userForm.allowedSkillIds" class="input" placeholder="Allowed skills" />
        <button class="btn" type="button" :disabled="!userForm.userId.trim()" @click="admin.createUser">Invite user</button>
      </section>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <h1>Private Agent Console</h1>
          <p v-if="activeUser">Signed in as {{ authUser }} · Active user {{ activeUser.displayName || activeUser.userId }} · {{ activeSkillName }}</p>
        </div>
        <div class="actions">
          <button class="ghost-btn" type="button" :disabled="loading" @click="admin.loadAll">
            {{ loading ? "Refreshing..." : "Refresh" }}
          </button>
          <button class="ghost-btn danger" type="button" @click="admin.logout">Logout</button>
        </div>
      </header>

      <p v-if="error" class="alert">{{ error }}</p>

      <section class="metrics" v-if="overview">
        <article class="metric">
          <span>Users</span>
          <strong>{{ overview.enabledUsers }}/{{ overview.users }}</strong>
        </article>
        <article class="metric">
          <span>Memories</span>
          <strong>{{ overview.memories }}</strong>
        </article>
        <article class="metric">
          <span>Pending</span>
          <strong>{{ overview.pendingCandidates }}</strong>
        </article>
        <article class="metric">
          <span>Skills</span>
          <strong>{{ overview.skills }}</strong>
        </article>
        <article class="metric wide" :class="{ warn: !overview.health.transport.ok }">
          <span>NapCat</span>
          <strong>{{ overview.health.transport.ok ? "Connected" : "Waiting" }}</strong>
          <small>{{ overview.health.transport.detail }}</small>
        </article>
      </section>

      <section class="grid system-grid">
        <article class="panel">
          <h2>
            System Health
            <button class="ghost-btn" type="button" @click="admin.refreshHealth">Detect</button>
          </h2>
          <div v-if="health" class="health-list">
            <div class="item slim">
              <div>
                <strong>NapCat · {{ health.transport.ok ? "normal" : "error" }}</strong>
                <small>{{ health.transport.detail }}</small>
              </div>
            </div>
            <div v-for="model in healthModels" :key="`${model.baseUrl}-${model.model}`" class="item slim">
              <div>
                <strong>{{ model.model }} · {{ model.ok ? "normal" : "error" }}</strong>
                <small>{{ model.baseUrl }} · {{ model.latencyMs }}ms · {{ model.cached ? "cached" : model.checkedAt }}</small>
                <p v-if="!model.ok">{{ model.detail }}</p>
              </div>
            </div>
            <div class="item slim">
              <div>
                <strong>{{ health.runtime.hostname }} · {{ health.runtime.nodeVersion }}</strong>
                <small>PID {{ health.runtime.pid }} · uptime {{ health.runtime.uptimeSeconds }}s · RSS {{ health.runtime.rssMb }}MB · heap {{ health.runtime.heapUsedMb }}MB</small>
              </div>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>
            Model Settings
            <button class="btn" type="button" :disabled="!systemSettings" @click="admin.saveSystemSettings">Save</button>
          </h2>
          <div v-if="systemSettings" class="model-settings">
            <label v-for="purpose in modelPurposes" :key="purpose">
              {{ purpose }}
              <select v-model="systemSettings.selectedModelIds[purpose]" class="input">
                <option value="">Auto</option>
                <option v-for="model in systemModels.filter((item) => item.purpose === purpose)" :key="model.id" :value="model.id">
                  {{ model.name }} / {{ model.model }}
                </option>
              </select>
            </label>
            <div v-for="model in systemSettings.models" :key="model.id" class="model-row">
              <label><input v-model="model.enabled" type="checkbox" /> {{ model.name }}</label>
              <input v-model="model.baseUrl" class="input" placeholder="Base URL" />
              <input v-model="model.model" class="input" placeholder="Model" />
              <input v-model="model.apiKey" class="input" :placeholder="model.hasApiKey ? 'API key configured' : 'API key'" />
            </div>
          </div>
        </article>
      </section>

      <section v-if="activeUser" class="grid">
        <article class="panel">
          <h2>User Settings</h2>
          <div class="form-grid">
            <label>
              Display name
              <input v-model="activeUser.displayName" class="input" />
            </label>
            <label>
              Current skill
              <select v-model="activeUser.currentSkillId" class="input">
                <option v-for="skill in skills" :key="skill.id" :value="skill.id">{{ skill.name }} / {{ skill.id }}</option>
              </select>
            </label>
            <label class="span-two">
              Allowed skills
              <input :value="activeAllowedSkillText" class="input" readonly />
            </label>
          </div>
          <div class="toggle-row">
            <label><input v-model="activeUser.enabled" type="checkbox" /> Enabled</label>
            <label><input v-model="activeUser.autoReplyEnabled" type="checkbox" /> Auto reply</label>
            <label><input v-model="activeUser.memoryEnabled" type="checkbox" /> Memory</label>
            <label><input v-model="activeUser.knowledgeEnabled" type="checkbox" /> Knowledge</label>
            <label><input v-model="activeUser.scheduledRemindersEnabled" type="checkbox" /> Reminders</label>
          </div>
          <button class="btn" type="button" @click="admin.saveUser(activeUser)">Save user</button>
        </article>

        <article class="panel">
          <h2>Pending Memories <span>{{ pendingCandidates.length }}</span></h2>
          <div v-if="!pendingCandidates.length" class="empty">No pending memory candidates.</div>
          <div v-for="candidate in pendingCandidates" :key="candidate.id" class="item">
            <div>
              <input v-model="candidate.title" class="input dense" />
              <textarea v-model="candidate.content" class="input textarea"></textarea>
              <small>{{ candidate.type }} · {{ Math.round(candidate.confidence * 100) }}%</small>
              <details v-if="candidate.evidence">
                <summary>Evidence</summary>
                <pre>{{ candidate.evidence.summary }}</pre>
              </details>
            </div>
            <div class="actions">
              <button class="ghost-btn strong" type="button" @click="admin.approveCandidate(candidate)">Approve</button>
              <button class="ghost-btn danger" type="button" @click="admin.rejectCandidate(candidate)">Reject</button>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>Long-Term Memories <span>{{ memories.length }}</span></h2>
          <div v-if="!memories.length" class="empty">No approved memories for this user.</div>
          <div v-for="memory in memories" :key="memory.id" class="item">
            <div>
              <input v-model="memory.title" class="input dense" />
              <textarea v-model="memory.content" class="input textarea"></textarea>
              <small>{{ memory.type }} · {{ memory.enabled ? "enabled" : "disabled" }}</small>
              <details v-if="memory.evidence">
                <summary>Evidence</summary>
                <pre>{{ memory.evidence.summary }}</pre>
              </details>
            </div>
            <div class="actions vertical">
              <button class="ghost-btn strong" type="button" @click="admin.saveMemory(memory)">Save</button>
              <button class="ghost-btn" type="button" @click="admin.toggleMemory(memory)">
                {{ memory.enabled ? "Disable" : "Enable" }}
              </button>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>Knowledge <span>{{ knowledge.length }}</span></h2>
          <div class="form-grid compact-form">
            <input v-model="knowledgeForm.title" class="input" placeholder="Title" />
            <input v-model="knowledgeForm.keywords" class="input" placeholder="Keywords" />
            <input v-model="knowledgeForm.question" class="input span-two" placeholder="Question" />
            <textarea v-model="knowledgeForm.answer" class="input textarea span-two" placeholder="Answer"></textarea>
            <label><input v-model="knowledgeForm.enabled" type="checkbox" /> Enabled</label>
            <div class="actions">
              <button class="btn" type="button" :disabled="!knowledgeForm.title.trim() || !knowledgeForm.answer.trim()" @click="admin.saveKnowledge">
                {{ knowledgeForm.id ? "Save FAQ" : "Add FAQ" }}
              </button>
              <button class="ghost-btn" type="button" @click="admin.resetKnowledgeForm">Clear</button>
            </div>
          </div>
          <div v-if="!knowledge.length" class="empty">No personal knowledge entries.</div>
          <div v-for="entry in knowledge" :key="entry.id" class="item">
            <div>
              <strong>{{ entry.title }}</strong>
              <p>{{ entry.question }}</p>
              <small>{{ entry.enabled ? "enabled" : "disabled" }} · {{ entry.keywords.join(", ") }}</small>
            </div>
            <div class="actions vertical">
              <button class="ghost-btn strong" type="button" @click="admin.editKnowledge(entry)">Edit</button>
              <button class="ghost-btn" type="button" @click="admin.toggleKnowledge(entry)">
                {{ entry.enabled ? "Disable" : "Enable" }}
              </button>
              <button class="ghost-btn danger" type="button" @click="admin.deleteKnowledge(entry)">Delete</button>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>Reminders <span>{{ reminders.length }}</span></h2>
          <div v-if="!reminders.length" class="empty">No private reminders.</div>
          <div v-for="task in reminders" :key="task.id" class="item slim">
            <div>
              <strong>{{ task.topic }}</strong>
              <small>{{ task.enabled ? "enabled" : "paused" }} · {{ task.dateRule || "all" }} · {{ task.executionStartTime || "interval" }} {{ task.executionEndTime || "" }} · next {{ task.nextRunAt }}</small>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>Skills</h2>
          <div v-for="skill in skills" :key="skill.id" class="item slim">
            <div>
              <strong>{{ skill.name }}</strong>
              <small>{{ skill.id }} · temp {{ skill.temperature }} · {{ skill.maxContextTurns }} turns</small>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>Candidate History</h2>
          <div v-if="!candidates.length" class="empty">No memory candidate history.</div>
          <div v-for="candidate in candidates.slice(0, 12)" :key="candidate.id" class="item slim">
            <div>
              <strong>{{ candidate.title }}</strong>
              <small>{{ candidate.status }} · {{ candidate.createdAt }}</small>
            </div>
          </div>
        </article>

        <article class="panel">
          <h2>Operation Logs</h2>
          <div v-if="!operationLogs.length" class="empty">No operation logs.</div>
          <div v-for="log in operationLogs" :key="`${log.time}-${log.action}-${log.detail || ''}`" class="item slim">
            <div>
              <strong>{{ log.action }}</strong>
              <small>{{ log.time }} · {{ log.actorUserId }} · {{ log.targetUserId || "-" }} {{ log.detail || "" }}</small>
            </div>
          </div>
        </article>
      </section>
    </section>
  </main>
</template>
