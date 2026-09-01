# Sons da chamada

Coloque neste diretório os efeitos sonoros usados durante a chamada.

Nomes reservados:

- `connect.ogg`: conexão ou entrada na chamada;
- `disconnect.ogg`: desconexão ou saída da chamada.

Esses arquivos serão copiados pelo Vite para `dist/audio/call` durante o build.
Use caminhos relativos, como `./audio/call/connect.ogg`, para que também funcionem
no aplicativo desktop empacotado.
