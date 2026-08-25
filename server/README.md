# Servidor central legado

Este diretório contém a arquitetura centralizada anterior do Risk. Ele não participa do aplicativo desktop P2P, não é iniciado pelo fluxo padrão e não deve receber novas funcionalidades.

O caminho suportado é Electron + sidecar local em `desktop-backend` + Supabase Realtime efêmero + WebRTC P2P. O servidor permanece temporariamente apenas para referência e migração de instalações antigas.
