<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
export default defineComponent({ name: 'NotFoundView', components: { Button } })
</script>
<template>
  <div class="empty-state panel" style="padding: 100px 24px">
    <i
      :class="['pi', $route.path === '/403' ? 'pi-lock' : 'pi-compass']"
      style="font-size: 40px; color: #8da7d9"
    ></i>
    <h1>{{ $route.path === '/403' ? '403 · 无访问权限' : '404 · 页面不存在' }}</h1>
    <p class="muted">
      {{
        $route.path === '/403'
          ? '当前账号不能访问这个管理页面。'
          : '链接可能已变更，请返回工作台继续。'
      }}
    </p>
    <Button label="返回工作台" icon="pi pi-arrow-left" @click="$router.push('/dashboard')" />
  </div>
</template>
