# Cómo levantar y apagar AllinMKT

## Antes de nada (solo la primera vez)

```bash
cd ~/projects/AllinMKT
node -v          # tiene que ser 22.12 o posterior
npm install
```

## Levantar

### Modo desarrollo (desde el código)

```bash
cd ~/projects/AllinMKT
npm run dev
```

Se abre la ventana y la terminal se queda ocupada mostrando los logs. Al guardar cambios en el código la app se recarga sola.

### App instalada

```bash
npm run dist:linux               # genera dist/AllinMKT-<versión>.AppImage y el .deb
./dist/AllinMKT-*.AppImage       # o instala el .deb y ábrela desde el menú de aplicaciones
```

Si ya está abierta, volver a lanzarla solo trae la ventana al frente (no abre una segunda copia).

## Apagar

Ojo: **cerrar la ventana con la X no apaga la app**. Por defecto sigue viva en la bandeja del sistema para poder publicar a su hora. Para apagarla de verdad:

| Situación | Cómo apagarla |
|---|---|
| Uso normal | Icono de AllinMKT en la bandeja › **Salir** |
| Modo desarrollo | `Ctrl+C` en la terminal donde corre `npm run dev` |
| Se ha quedado colgada o no ves el icono | `pkill -f AllinMKT` (app instalada) o `pkill -f electron-vite` (desarrollo) |

Para que la X cierre la app del todo, desactiva **Ajustes › Seguir en la bandeja al cerrar**.

## Comprobar si está corriendo

```bash
pgrep -af "AllinMKT|electron" 
```

Si no sale nada, está apagada.

## Arranque automático

**Ajustes › Abrir al iniciar sesión** hace que arranque minimizada en la bandeja al entrar en el equipo. Desactívalo ahí mismo para que deje de hacerlo.

> Mientras la app está apagada no se publica nada. Al volver a levantarla publica lo pendiente dentro del margen configurado (12 h por defecto); lo que quede fuera se marca como fallido para reprogramarlo.
