/// <reference types="vite/client" />
import { render } from "solid-js/web";
import { Player } from "./Player";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Polyptic player: missing #root element");
}

render(() => <Player />, root);
