# OpenClaw 认证配置问题修复

## 问题描述

```
Auth store: /home/node/.openclaw/agents/main/agent/auth-profiles.json
(agentDir: /home/node/.openclaw/agents/main/agent).
Configure auth for this agent (openclaw agents add <id>)
or copy auth-profiles.json from the main agentDir.
```

## 原因分析

OpenClaw 在运行时需要创建以下目录结构：
```
/home/node/.openclaw/
├── openclaw.json          (配置文件，从 Secret 挂载，只读)
├── agents/                (运行时创建，需要可写)
│   └── main/
│       └── agent/
│           └── auth-profiles.json
└── workspace/             (工作区，需要可写)
```

之前的配置只挂载了 `openclaw.json`（只读），但 OpenClaw 需要在 `agents/` 目录下创建文件。

## 解决方案

### 方案 1: 使用 emptyDir（临时存储，推荐用于测试）

已在 `openclaw-deployment.yaml` 中实现：

```yaml
volumeMounts:
- name: openclaw-data
  mountPath: /home/node/.openclaw/agents
  subPath: agents
- name: openclaw-data
  mountPath: /home/node/.openclaw/workspace
  subPath: workspace

volumes:
- name: openclaw-data
  emptyDir: {}
```

**特点**:
- ✅ 简单，无需额外配置
- ✅ 性能好（内存或本地磁盘）
- ⚠️ Pod 重启后数据丢失
- ⚠️ 每次启动需要重新初始化

**适用场景**: 开发/测试环境

### 方案 2: 使用 PersistentVolumeClaim（持久化存储，推荐用于生产）

创建 PVC 并挂载：

```yaml
# pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-data-pvc
  namespace: shengsuanyun
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  # storageClassName: your-storage-class
```

修改 Deployment:

```yaml
volumes:
- name: openclaw-data
  persistentVolumeClaim:
    claimName: openclaw-data-pvc
```

**特点**:
- ✅ 数据持久化，Pod 重启不丢失
- ✅ 适合生产环境
- ⚠️ 需要配置存储类
- ⚠️ 只支持单实例（ReadWriteOnce）

**适用场景**: 生产环境

### 方案 3: 使用 initContainer 预创建目录

如果需要预设某些配置，可以使用 initContainer：

```yaml
initContainers:
- name: init-openclaw
  image: busybox:1.36
  command: ['sh', '-c']
  args:
    - |
      mkdir -p /data/agents/main/agent
      mkdir -p /data/workspace
      chown -R 1000:1000 /data
  volumeMounts:
  - name: openclaw-data
    mountPath: /data
```

## 当前配置（方案 1 - emptyDir）

### 部署命令

```bash
# 部署所有资源
kubectl apply -f openclaw-secrets.yaml \
              -f openclaw-deployment.yaml \
              -f openclaw-service.yaml

# 查看日志
kubectl logs -f -n shengsuanyun -l app=openclaw-gateway
```

### 验证配置

```bash
# 获取 Pod 名称
POD_NAME=$(kubectl get pod -n shengsuanyun -l app=openclaw-gateway -o jsonpath='{.items[0].metadata.name}')

# 检查目录结构
kubectl exec -n shengsuanyun $POD_NAME -- ls -la /home/node/.openclaw/

# 应该看到:
# drwxr-xr-x  agents/
# -rw-------  openclaw.json (从 Secret 挂载)
# drwxr-xr-x  workspace/

# 检查 agents 目录是否可写
kubectl exec -n shengsuanyun $POD_NAME -- touch /home/node/.openclaw/agents/test.txt
kubectl exec -n shengsuanyun $POD_NAME -- ls -la /home/node/.openclaw/agents/
```

### 查看认证配置

OpenClaw 启动后会自动创建 `auth-profiles.json`：

```bash
# 等待 Pod 启动
kubectl wait --for=condition=ready pod -l app=openclaw-gateway -n shengsuanyun --timeout=60s

# 查看创建的认证文件
kubectl exec -n shengsuanyun $POD_NAME -- cat /home/node/.openclaw/agents/main/agent/auth-profiles.json
```

## 升级到持久化存储（生产环境）

如果您需要数据持久化：

### 1. 创建 PVC

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-data-pvc
  namespace: shengsuanyun
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
EOF
```

### 2. 更新 Deployment

编辑 `openclaw-deployment.yaml`，将 `emptyDir` 改为 `persistentVolumeClaim`：

```yaml
volumes:
- name: openclaw-data
  persistentVolumeClaim:
    claimName: openclaw-data-pvc
```

### 3. 重新部署

```bash
kubectl apply -f openclaw-deployment.yaml
kubectl rollout restart deployment/openclaw-gateway -n shengsuanyun
```

## 常见问题

### Q1: Pod 启动但日志显示认证错误

**检查**:
```bash
# 查看完整日志
kubectl logs -n shengsuanyun -l app=openclaw-gateway --tail=100

# 检查环境变量
kubectl exec -n shengsuanyun $POD_NAME -- env | grep OPENCLAW

# 检查配置文件
kubectl exec -n shengsuanyun $POD_NAME -- cat /home/node/.openclaw/openclaw.json | jq '.auth'
```

### Q2: 权限拒绝错误

**检查**:
```bash
# 检查目录权限
kubectl exec -n shengsuanyun $POD_NAME -- ls -lan /home/node/.openclaw/

# 应该看到所有者是 1000:1000 (node 用户)
```

### Q3: 配置文件未找到

**检查**:
```bash
# 验证 Secret 存在
kubectl get secret openclaw-config -n shengsuanyun

# 验证 Secret 内容
kubectl get secret openclaw-config -n shengsuanyun -o jsonpath='{.data.openclaw\.json}' | base64 -d | jq

# 验证挂载
kubectl exec -n shengsuanyun $POD_NAME -- cat /home/node/.openclaw/openclaw.json
```

## 数据备份（如果使用 PVC）

```bash
# 备份数据
kubectl exec -n shengsuanyun $POD_NAME -- tar czf /tmp/backup.tar.gz \
  /home/node/.openclaw/agents \
  /home/node/.openclaw/workspace

kubectl cp shengsuanyun/$POD_NAME:/tmp/backup.tar.gz ./openclaw-backup-$(date +%Y%m%d).tar.gz

# 恢复数据
kubectl cp ./openclaw-backup-20260225.tar.gz shengsuanyun/$POD_NAME:/tmp/backup.tar.gz
kubectl exec -n shengsuanyun $POD_NAME -- tar xzf /tmp/backup.tar.gz -C /
kubectl rollout restart deployment/openclaw-gateway -n shengsuanyun
```

## 总结

现在的配置：
- ✅ 配置文件 `openclaw.json` 从 Secret 挂载（只读）
- ✅ `agents/` 和 `workspace/` 目录使用 emptyDir（可写）
- ✅ OpenClaw 可以创建 `auth-profiles.json` 和其他运行时文件
- ⚠️ 使用 emptyDir，Pod 重启数据会丢失

如需生产环境使用，建议切换到 PVC 实现数据持久化。
