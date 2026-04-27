<!--markdownlint-disable-->

# Requests for this CLI: THESE ARE THE MINIMUM REQUIREMENTS; YOU CAN CHOOSE TO ADD, BUT NOT REMOVE OR CHANGE THINGS. ALSO READ THROUGH THE FILE BEFORE MAKING CHANGES

## Main Goal

To make a cross-platform folder opener to help developers open their active projects quicker and more efficiently. It should be very intuititive. It should be clearly listing of the instructions and requirements in the README. People should be able to be clone it anywhere and start the setup.

# **_IMPORTANT! YOU CAN CHANGE ANYTHING YOU WANT, ANY FILE, AS LONG AS THE FEATURES ARE IMPLEMENTED. YOU DO NOT HAVE TO TRY TO KEEP THE CURRENT STRUCTURE, PACKAGES, SCRIPTS, TYPES, OR ANYTHING. REALLY I MEAN ANYTHING_**

## Features

### Setup

The setup should make everything ready to use.

Required steps:

- Enter the directory that includes the config and storage files. default is `<cwd>/storage`.
- Enter the folder openers. Choose which way to tell the user as you see fit about how to input the data. Ensure after this step that the user has atleast one opener ready to go.
- Enter the first reference and path. this should be optional but recommended
- ANY STEP YOU CHOOSE TO ADD, OR NONE. DO NOT FEEL OBLIGED TO ONLY ADD THE ABOVE STEPS.

## Use

The using UX should be very intuitive with colors and ascii and anything that you see fit. It should look like a very professional cli, with multi-choice options navigate through arrow keys and stuff like that.

Dangerous actions such as clearing or changing storage/config paths need confirmation.

### A few commands to start with

- `add`:  
  usage: `add \<ref> \<path (absolute)`

- `config`: should support both an interactive menu and direct command-based changes.

- `config`:  
  To change the configuration. add options like choosing the command for bin, choosing storage paths etc. (important: config path (once initialized) should always be in .env as CONFIG_PATH as an absolute url)

- `rm \<id \| ref>`: remove by id

- `clr`: clears all locations

- `help`: shows help msg

- `doctor`: checks if everything is okay, such as storage file and config file are following schema, if the paths stored actually exist (if not ask the user if they want to delete those).

- `update`: updates the cli by cloning repo, migrates storage, config, and sets up env automatically. This is very important. Please make this feature as seamless as possible and make sure everything will work when updating.

- ADD MORE FEATURES PLEASE!!!

## Config

The config should be stored as json, and follow VERY strict zod schemas (see the ones i made in types.ts).

The core goal of the config is to make the cli know everything it needs to know everything it ever needs to know.

# Before you go and make the best developer tool ever: DO WHAT YOU THINK IS RIGHT. I TRUST YOU WITH THIS
